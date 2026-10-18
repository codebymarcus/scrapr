# Run Items Panel & Unified New-Run Form — Design

**Date:** 2026-10-18
**Status:** Approved (design); plan to follow

## Intent & Why

Starting a run is split across two dialogs (New Run + a separate Import List),
and once a run is queued or running the operator can see only an aggregate
progress meter — not which rows will be scraped, which succeeded, which failed
and why, or whether each row's output actually reached Google Drive. Upload also
happens invisibly inline during the run, so a row can finish scraping yet never
upload (Drive off at the time, a transient Drive error) with no way to see it or
fix it. This work gives the operator one place to start a run and a per-item
panel to watch and act on each row.

## Goals

- **One New Run form.** Merge sheet import into the New Run form: pick a project,
  then supply URLs by pasting them *or* uploading a sheet, plus the existing
  image overrides (format, Drive on/off, folder, subfolder). Retire the separate
  Import List dialog.
- **An expandable per-item panel** on the run card, usable while queued (preview
  of rows to scrape), during the run (live), and after it finishes. Columns:
  - **Row** — the item's name (from the sheet's name column) and/or URL.
  - **Status** — completed / pending / skipped / failed (with the failure reason
    shown on failed rows).
  - **Upload** — uploaded / not yet uploaded (image runs only).
  - **Action** — context-appropriate: Upload (a scraped-but-not-uploaded row),
    Retry (a failed row — re-scrape), Open in Drive (an uploaded row), Remove (a
    not-yet-run row).
- **Per-item upload state + on-demand upload.** Track each image row's upload
  state and Drive link; let the operator upload a single scraped row on demand
  (covering rows that finished while Drive was off, or whose upload failed).
  Auto-upload during the run stays (when Drive is on); the manual action
  supplements it.
- **Bulk actions** on the panel: "Upload all pending" and "Retry all failed".
- **Edit the list before running:** remove/skip a row from a queued (or stopped)
  run.

## Non-Goals

- Creating or editing the project's recipe inside the New Run form. A run still
  targets an existing project (the recipe/site config stays in the Builder); the
  form only chooses the project and supplies this run's URL list + per-run
  overrides. (Confirmed with the user.)
- Changing when auto-upload happens. Auto-upload stays inline during the run when
  Drive is on; this work adds visibility and a manual path, not a new upload
  schedule.
- Uploading loose images. Only the packaged `.cbz`/`.pdf` is uploadable, as today.
- Deleting already-uploaded files from Google Drive.
- Text runs' upload column/action (text runs never upload; the panel still shows
  their status).

## Anti-Goals (failure even if it "works")

- A manual Upload button that can't find the row's output file (so it must rely
  on a recorded output path, not re-guessing the filename).
- An item panel that re-renders a 500-row run as one un-paginated DOM and janks
  the page.
- A "Retry" that silently re-scrapes rows the operator didn't ask to retry.
- Upload state that drifts from reality (e.g. shows "uploaded" after a failed
  upload, or "not uploaded" for a row the run already uploaded).

## Constraints

- Build on the existing stack: Fastify 5 + better-sqlite3 + zod server (Node
  ESM), React 19 + TanStack Query + SCSS-module web, the shared engine
  (`BatchRunner`/`scrapeJob`/`DriveUploader`). Tests: `node:test` (server/engine),
  Vitest (web). Pristine test output.
- Reuse the live websocket hub + `item` events already wired; extend them rather
  than adding new transport.
- The run still executes through `BatchRunner`; `StoreJobSource.hasStatus` is
  true and `skipReason` skips `done`/`skip` rows on a re-run (failed rows are
  marked `retry`), which this design relies on for retry.
- Per-run Drive/format settings come from `buildRunConfig(recipe, { overrides,
  driveAuth })`; on-demand upload must reconstruct the same config so a row
  uploads to the same folder it would have during the run.
- Migrations are additive (new `004_*`), never edits to existing ones.

## The How — decisions made

### 1. Unified New Run form

`NewRunDialog` keeps the project dropdown, label, and image overrides, and gains
a **file upload** control beside the existing URLs textarea: the operator pastes
URLs or uploads a sheet (csv/tsv/txt/xlsx/xls), not both. The form uses the
existing endpoints: `POST /api/runs` to create, then either `POST
/api/runs/:id/items` (pasted URLs) or `POST /api/runs/import` with the `runId`
(uploaded sheet, which already captures the name column). The standalone
`ImportListDialog` is removed and its entry points updated. (Builder: whether to
show a small parsed-preview of an uploaded sheet before creating the run, reusing
the import endpoint's no-`runId` preview mode, is a nice-to-have left open.)

### 2. Per-item state model

**Status (derived, four values):** computed from `run_items` for display:
- **completed** — `saved != null` and the row finished ok (status `done`).
- **failed** — status `retry` or a recorded failure (`reason` set, not complete).
- **skipped** — status `skip` (or circuit-breaker skipped: `reason` starts
  "skipped:").
- **pending** — anything else (not yet run).
The exact derivation (and where it lives — a shared helper used by the web) is
the builder's to finalize; these four are the contract.

**Upload state (new, persisted):** add columns to `run_items` (migration
`004_item_upload`): an upload flag/time and the Drive link, e.g. `uploaded_at
TEXT`, `drive_link TEXT`, and `output_name TEXT` (the base filename the engine
produced for this row, so on-demand upload can locate the file). Final column
names are the builder's call; the capability — "did this row upload, what's its
Drive link, and what file did it produce" — is required.

### 3. Engine separates scrape outcome from upload outcome

**Decided (supersedes the earlier "no control-flow change" wording):** a row that
scrapes successfully but fails to upload (or had Drive off) is **completed, not
uploaded** — never a scrape failure. Concretely:

- `scrapeJob` returns `complete: true` when the scrape+packaging succeeded, with a
  separate `uploaded` boolean and (when uploaded) the Drive result; an upload
  failure sets `uploaded: false` but keeps `complete: true` and leaves the local
  files in place (the existing cleanup guard already refuses to delete when not
  uploaded). It no longer returns `complete:false` for an upload-only failure.
- `_runJobs` therefore marks such a row `status: "done"` (so a re-run's
  `skipReason` skips it — no re-download) with a reason noting the upload is
  pending, and the circuit breaker / run summary must NOT count an upload-only
  failure as a scrape failure or trip the domain breaker.
- This also changes the **CLI/terminal**: an upload failure keeps the files and
  does not flag the row for a full re-scrape (an improvement; terminal scraping
  itself is unchanged).

`scrapeJob` also returns, for image rows, the output base name it chose
(`job.name` > title > slug, already computed as `finalTargets`) and which
package(s) it wrote. `run-manager`'s `onItem` persists the output name, the
`uploaded`/`drive_link` state, and includes them in the emitted `item` event.
Status derivation (§2) maps completed + not-uploaded → the **Upload** action
(never Retry/re-scrape).

### 4. On-demand upload (per item + bulk)

`POST /api/runs/:id/items/:itemId/upload`:
- 404 if the run/item is unknown; 409 if the run is currently running, the
  project is a text recipe, or Drive is not connected.
- Rebuild the run's engine config via `buildRunConfig(recipe, { overrides:
  run.overrides, driveAuth: driveAuth.loadAuthConfig() })`, `DriveUploader.create`
  it, locate the row's `.cbz`/`.pdf` in the run's output dir (from the recorded
  `output_name`), `uploadFile` it, then persist `uploaded_at`/`drive_link` and
  emit an `item` event.
`POST /api/runs/:id/upload-pending` uploads every completed-but-not-uploaded
image row the same way (bulk). Reuses the per-item path.

**Drive link coverage (decided):** so "Open in Drive" always has a link and
upload state never drifts, `DriveUploader.uploadFile` must return `webViewLink`
on BOTH the create path and the idempotent "already there" branch (add
`webViewLink` to `_findExisting`'s `fields`), and the **auto-upload** path in
`scrapeJob` must capture that return (not discard it) so a row uploaded during
the run records its `drive_link` too. For a `format: "both"` row the single
`drive_link` is the `.cbz`'s link (fall back to the `.pdf`'s when only pdf).

**Refresh model (decided):** upload/retry/remove actions target queued, stopped,
or terminal runs, where the live socket is off. These use the standard pattern —
the mutation invalidates the run-detail (and list) query — and the item panel
**fetches the run detail whenever it is expanded, not only while running**. The
websocket stays running-only (unchanged); the server-side `item` emits on these
endpoints are belt-and-suspenders for a run that happens to be live, not the
primary refresh path.

### 5. Retry (per item + bulk)

- **Retry all failed:** reset failed rows to a re-runnable state (clear
  `saved`/`reason`, set status so `skipReason` won't skip them) and requeue +
  start the run; `done` rows are skipped, so only failed rows re-scrape.
- **Retry one row (decided):** reuse the existing run manager rather than a
  parallel execution path — reset that row to re-runnable, then requeue + start
  the run through the normal single-active-run queue. The run shows `running` and,
  because `done` rows are skipped, re-scrapes the reset row (and any other rows
  still in a failed/`retry` state). If another run is active, it queues, as any
  start does. The strict "only this row, run stays terminal" variant is a
  possible later refinement, not part of this work; the UI copy should say Retry
  re-runs the failed rows. This keeps the run-manager/queue/socket path unchanged.

### 6. Remove/skip a row before running

`DELETE /api/runs/:id/items/:itemId` removes a row from a `queued`/`stopped` run
(409 while running). Used from the panel to prune the imported list.

### 7. Item panel UI

An expandable section on `RunCard` (available in every state, not only running),
rendering a table from the run detail's `items` (already fetched; extended with
upload state). Each row shows name/URL, a status badge, an upload badge (image
runs), the failure reason on failed rows, and the context action(s): Upload /
Retry / Open in Drive / Remove. Bulk buttons ("Upload all pending", "Retry all
failed") sit above the table. It updates live from `item` events during a run.
Large lists are **paginated client-side** (my call: a page size around 50 with
simple next/prev, or windowing — builder picks the lighter option) so the DOM
stays bounded. The live log console (from the prior work) stays; the panel and
the console coexist (builder decides tabs vs stacked).

## Left to the builder

- Exact new column names and the `item` event's new fields; the websocket events
  for upload-state changes and item removal (extend the existing `item` event vs
  a new type).
- The status-derivation helper's precise rules and where it's shared.
- The single-item retry execution mechanism (scoped one-item run vs
  reset-and-requeue), per §5.
- The merged form's exact layout and whether to show a pre-create sheet preview.
- Pagination vs windowing for the item table, and page size.
- How the panel and the existing console are arranged on the card.
- Disabling/hiding upload actions when Drive isn't connected or the project is a
  text recipe; disabling edit/remove/retry while the run is running.
- Tests (TDD): status derivation, the new endpoints (upload/retry/remove, incl.
  409 guards), engine output/upload fields recorded, the merged form's two input
  paths, and the panel's rendered states + live updates.

## Key files (orientation)

- Engine: `src/pipeline.mjs` (`scrapeJob` return, `_runJobs`/`onItem`),
  `src/drive.mjs` (`uploadFile` returns `webViewLink`), `src/naming.mjs`.
- Server: `dashboard/server/src/db/{migrations,store}.mjs`,
  `routes/runs.mjs`, `run-manager.mjs`, `build-run-config.mjs`,
  `schemas.mjs`, `hub.mjs`.
- Web: `features/runs/components/{NewRunDialog,RunCard,ImportListDialog}.tsx`,
  `features/runs/{api/runs-api.ts,hooks/*,types.ts}`, `lib/schemas.ts`.
