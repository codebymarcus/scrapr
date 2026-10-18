# Run Items Panel & Unified New-Run Form — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One New Run form (paste URLs or upload a sheet) and an expandable per-item panel on the run card showing each row's status, upload state, failure reason, and per-item + bulk actions (upload, retry, remove, open in Drive).

**Architecture:** Extend the existing Fastify + better-sqlite3 server, the shared engine, and the React/TanStack-Query web app. The engine separates scrape success from upload success (an upload-only failure keeps the row "done" + not-uploaded) and reports each row's output name + Drive link; the server persists per-item upload state and adds remove/retry/upload endpoints; the web merges import into New Run and renders a live, paginated item panel.

**Tech Stack:** Node ESM (`.mjs`) engine + server, Fastify 5, better-sqlite3, zod, googleapis; React 19 + TypeScript + TanStack Query + SCSS modules. Tests: `node:test` (engine/server), Vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-18-run-items-panel-design.md`

## Global Constraints

- Node ESM only on engine/server (no TypeScript there). Pristine test output.
- Engine tests: `npm test` (repo root). Server: `cd dashboard/server && npm test`. Web: `cd dashboard/web && npm test` + `npm run build`.
- The CLI/terminal path keeps working; terminal *scraping* behavior is unchanged. The one intended CLI change: an upload-only failure now keeps files and marks the row `done` (not `retry`) instead of flagging a full re-scrape.
- A run still targets an existing project; the New Run form does NOT create/edit recipes.
- Only packaged `.cbz`/`.pdf` upload; loose images and text runs never upload. Already-uploaded Drive files are never deleted.
- Migrations additive (`004_*`), never edits to existing migrations.
- Auto-upload during a run (when Drive is on) stays; manual upload supplements it.
- Status contract (four values, derived from `run_items`): **completed** (scrape done, `saved != null`, status `done`), **failed** (status `retry` / recorded scrape failure), **skipped** (status `skip` or circuit-breaker skip), **pending** (not yet run). Upload state is separate (image rows only): uploaded (has `uploaded_at`) vs not.

## Review Focus

- **Upload a row whose output file is missing on disk** (cleaned up, or never produced): the upload endpoint returns a clear 4xx and leaves upload state unchanged — never a 500. → test in Task 5.
- **On-demand upload when Drive is not connected / token undecryptable**: 409 with a clear message, no crash. → test in Task 5.
- **remove / retry / upload on a running run**: rejected 409. → tests in Tasks 4 & 5.
- **A large imported list (hundreds of rows)** in the panel: paginated/windowed, DOM stays bounded. → test in Task 8.
- **Duplicate upload** (row already uploaded, or Drive reports "already there"): idempotent — records the link, doesn't error or double-count. → tests in Tasks 1 (engine `_findExisting` link) & 5 (endpoint).

---

### Task 1: Engine — separate scrape vs upload outcome; report output + Drive link

**Files:**
- Modify: `src/pipeline.mjs` (`scrapeJob` return; `_runJobs` status/breaker handling)
- Modify: `src/drive.mjs` (`_findExisting` fields; `uploadFile` return on both paths)
- Test: `test/pipeline.test.mjs`, `test/drive.test.mjs`

**Interfaces:**
- Produces: `scrapeJob(...)` resolves to its existing fields plus `{ outputName: string|null, uploaded: boolean, driveLink: string|null, cbz: boolean, pdf: boolean }`. On a scrape success whose upload fails, it returns `complete: true, uploaded: false` (NOT `complete:false`) and leaves local files in place. `outputName` is `path.basename(finalTargets.outDir)` (the name chosen: job.name > title > slug).
- `DriveUploader.uploadFile(path)` returns metadata including `webViewLink` on BOTH the create and the "already there" branches.

- [ ] **Step 1: Write failing `drive.test.mjs`** — add a fake drive whose `files.list` returns an existing file and whose `files.create` is not called; assert `uploadFile` resolves with `webViewLink` populated from the existing match (requires `webViewLink` in `_findExisting` fields). Keep the existing create-path test.
- [ ] **Step 2: Run** `npm test` (root) → FAIL. **Step 3: Implement** — add `webViewLink` to `_findExisting`'s `fields`; return the existing match's metadata (incl. link) from `uploadFile`. **Step 4: Run → PASS.**
- [ ] **Step 5: Write failing `pipeline.test.mjs` cases** (use the existing injected-`scrapeJob`/fake patterns):
  - scrape ok + uploader whose `uploadFile` throws → `scrapeJob` result has `complete: true, uploaded: false`, local files not deleted, and `_runJobs` records the row `status: "done"` (not `retry`) and does not count it as a breaker failure.
  - scrape ok + upload ok → `uploaded: true`, `driveLink` set, `outputName` set.
- [ ] **Step 6: Run → FAIL. Step 7: Implement** in `scrapeJob`: wrap the upload so an upload failure logs, sets `uploaded=false`, keeps `complete` true, and returns `driveLink` from a successful `uploadFile`; always return `outputName`/`cbz`/`pdf`. In `_runJobs`, base `complete`/status/breaker on scrape success, and set the reason to note a pending upload when `!uploaded`. **Step 8: Run full root suite → PASS.**
- [ ] **Step 9: Commit** — `feat(engine): separate scrape vs upload outcome; report output name + Drive link`.

---

### Task 2: DB migration + store methods for per-item upload state

**Files:**
- Modify: `dashboard/server/src/db/migrations.mjs` (migration `004_item_upload`)
- Modify: `dashboard/server/src/db/store.mjs`
- Test: extend `dashboard/server/test/store.test.mjs`

**Interfaces:**
- Migration `004_item_upload`: `ALTER TABLE run_items ADD COLUMN output_name TEXT; ADD COLUMN uploaded_at TEXT; ADD COLUMN drive_link TEXT;` (three statements).
- `store.setItemResult(id, { saved, total, needsReview, outputName })` — also persists `output_name` when provided (keep existing fields; `outputName` optional).
- `store.setItemUpload(id, { uploadedAt, driveLink })` — persists upload state.
- `store.deleteItem(id)` — removes one run_item.
- `store.getItem(id)` — returns the full row (incl. url, name, status, saved, output_name, uploaded_at, drive_link, run_id) or null.
- `listItems` already returns `*`, so new columns surface automatically.

- [ ] **Step 1: Add migration `004_item_upload`.**
- [ ] **Step 2: Write failing store tests** — `setItemResult` with `outputName` persists it; `setItemUpload` sets `uploaded_at`/`drive_link`; `getItem` returns the row incl. new cols; `deleteItem` removes it and leaves others.
- [ ] **Step 3: Run → FAIL. Step 4: Implement** (prepared statements + methods, mirroring existing style). **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** — `feat(server): per-item upload-state columns + store methods`.

---

### Task 3: run-manager persists output/upload state and emits it

**Files:**
- Modify: `dashboard/server/src/run-manager.mjs` (`onItem`)
- Test: extend `dashboard/server/test/run-manager.test.mjs`

**Interfaces:**
- Consumes: Task 1 `rec` fields (`outputName`, `uploaded`, `driveLink`), Task 2 store methods.
- `onItem(rec)`: persists `store.setItemResult(rec.id, { saved, total, needsReview, outputName: rec.outputName })` and, when `rec.uploaded`, `store.setItemUpload(rec.id, { uploadedAt: now(), driveLink: rec.driveLink })`; emits an `item` event extended with `outputName`, `uploaded`, `driveLink` (plus the existing fields).

- [ ] **Step 1: Write a failing `run-manager.test.mjs` case** — with a fake runner whose injected `onItem` is fed a rec `{ id, saved, total, ok:true, outputName:"Issue 1", uploaded:true, driveLink:"http://d/1" }`, assert the store recorded the output name + upload state and the emitted `item` event carries them. (Follow the file's fake-runner pattern.)
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run full server suite → PASS.**
- [ ] **Step 5: Commit** — `feat(server): persist + emit per-item output/upload state`.

---

### Task 4: Routes — remove item; retry (item + failed)

**Files:**
- Modify: `dashboard/server/src/routes/runs.mjs`
- Modify: `dashboard/server/src/app.mjs` (pass `runManager` already present; no new dep here)
- Test: extend `dashboard/server/test/runs.test.mjs`, `dashboard/server/test/run-routes.test.mjs`

**Interfaces:**
- Consumes: Task 2 `store.deleteItem`/`getItem`; existing `runManager.start`.
- `DELETE /api/runs/:id/items/:itemId` → 404 unknown; 409 if run is `running`; else `store.deleteItem` and return `{ deleted: true }`.
- `POST /api/runs/:id/retry` (retry all failed) → 409 if running; reset failed rows (`store` helper: clear `saved`/`reason`/upload, set status so `skipReason` re-runs them), set run `queued`, `runManager.start(id)`, return `{ run }`.
- `POST /api/runs/:id/items/:itemId/retry` → same, scoped to resetting that one row, then requeue+start (per design §5: reuse the manager; other failed rows may also re-run). 409 if running.
- A store helper `resetItemsForRetry(runId, { itemId? })` (reset one or all failed) lives in Task 2's store (add it there if simpler — builder's call; name it in the Interfaces either way).

- [ ] **Step 1: Write failing route tests** — delete item (200 + gone; 409 while running; 404 unknown); retry-failed and retry-one return 201/200 and leave the run startable (use a fake/real run manager as the file does). *(Review Focus: 409 guards.)*
- [ ] **Step 2: Run → FAIL. Step 3: Implement** routes + the reset helper. **Step 4: Run server suite → PASS.**
- [ ] **Step 5: Commit** — `feat(server): remove-item + retry endpoints`.

---

### Task 5: Routes — on-demand upload (per item + bulk)

**Files:**
- Modify: `dashboard/server/src/routes/runs.mjs`
- Modify: `dashboard/server/src/app.mjs` + `dashboard/server/src/server.mjs` (inject `driveAuth` and `emit` into `runRoutes`)
- Create: `dashboard/server/src/upload-item.mjs` (shared upload helper)
- Test: extend `dashboard/server/test/runs.test.mjs`; `dashboard/server/test/upload-item.test.mjs`

**Interfaces:**
- Consumes: Task 2 store (`getItem`, `setItemUpload`, project/run/overrides), `buildRunConfig`, `DriveUploader`, `driveAuth.loadAuthConfig()`.
- `uploadItem({ store, driveAuth, runOutDir, DriveUploaderFactory? }, runId, itemId) -> Promise<{ driveLink }>` — rebuild config via `buildRunConfig(recipe, { overrides: run.overrides, driveAuth: driveAuth.loadAuthConfig() })`, create the uploader, locate the row's `.cbz`/`.pdf` in `runOutDir(run)` from `output_name` (prefer cbz), `uploadFile`, `store.setItemUpload`. Throws typed errors for: not configured/connected, text/loose run, missing output file. `DriveUploaderFactory` injectable for tests (no real Google).
- `POST /api/runs/:id/items/:itemId/upload` → 404 unknown; 409 if running, Drive not connected, or text recipe; 4xx (not 500) if the output file is missing; else `{ uploaded: true, driveLink }`.
- `POST /api/runs/:id/upload-pending` → uploads each completed-not-uploaded image row via the helper; returns `{ uploaded: <count> }`; skips rows with missing files (reported in the count, not a 500).

- [ ] **Step 1: Write failing `upload-item.test.mjs`** with a fake store + fake `DriveUploaderFactory`: uploads a row and records `uploaded_at`/`drive_link`; **missing output file → throws a typed "no output" error, upload state unchanged** *(Review Focus)*; **Drive not configured → typed error** *(Review Focus)*; a row already uploaded / Drive "already there" still records a link and doesn't error *(Review Focus: idempotent)*.
- [ ] **Step 2: Run → FAIL. Step 3: Implement `upload-item.mjs`. Step 4: Run → PASS.**
- [ ] **Step 5: Write failing route tests** — upload endpoint maps the typed errors to 409/4xx (not 500); 409 while running; bulk upload-pending returns a count. **Step 6: Run → FAIL. Step 7: Implement routes + wire `driveAuth`/`emit` through `app.mjs`/`server.mjs`. Step 8: Run server suite → PASS.**
- [ ] **Step 9: Commit** — `feat(server): on-demand per-item + bulk Drive upload`.

---

### Task 6: Web — schemas, item-status helper, API, hooks

**Files:**
- Modify: `dashboard/web/src/lib/schemas.ts` (`itemSchema`, `runEventSchema` item variant)
- Modify: `dashboard/web/src/features/runs/types.ts` (status helper + types)
- Modify: `dashboard/web/src/features/runs/api/runs-api.ts`
- Create: `dashboard/web/src/features/runs/hooks/use-item-actions.ts`
- Test: extend `dashboard/web/src/lib/schemas.test.ts`; `dashboard/web/src/features/runs/hooks/use-item-actions.test.ts`; a small test for the status helper

**Interfaces:**
- `itemSchema` gains `output_name`, `uploaded_at`, `drive_link` (all nullish); `runEventSchema` item variant gains `outputName?`, `uploaded?`, `driveLink?`.
- `deriveItemStatus(item) -> "completed" | "pending" | "skipped" | "failed"` and `isUploaded(item) -> boolean` in `types.ts`, per the Global Constraints contract.
- API: `deleteItem(runId, itemId, client?)`, `uploadItem(runId, itemId, client?)`, `uploadPending(runId, client?)`, `retryRun(runId, client?)`, `retryItem(runId, itemId, client?)`.
- `useItemActions(client?)` exposing `remove`, `upload`, `uploadPending`, `retry`, `retryItem` mutations; each invalidates `runKeys.detail(runId)` and `runKeys.lists()` on success (the refresh model for non-running runs — no socket).

- [ ] **Step 1: Write failing tests** — schema accepts the new item fields; `deriveItemStatus` maps the four cases and `isUploaded` reflects `uploaded_at`; `useItemActions.remove/upload/retry` call the right method+path and invalidate the detail query (mock client, like existing hook tests).
- [ ] **Step 2: Run → FAIL. Step 3: Implement. Step 4: Run + `npm run build` → PASS.**
- [ ] **Step 5: Commit** — `feat(web): item schema, status helper, item-action hooks`.

---

### Task 7: Web — unified New Run form (paste or upload)

**Files:**
- Modify: `dashboard/web/src/features/runs/components/NewRunDialog.tsx`
- Modify: `dashboard/web/src/features/runs/components/RunsPage.tsx` (drop the separate Import entry)
- Remove: `dashboard/web/src/features/runs/components/ImportListDialog.tsx` (+ its test) — fold its upload into the form
- Test: extend `dashboard/web/src/features/runs/components/NewRunDialog.test.tsx`

**Interfaces:**
- Consumes: existing `useImport` (`POST /api/runs/import` with `runId`) and `useEnqueue`.
- The dialog offers a file picker **and** the URLs textarea; on submit it creates the run, then enqueues pasted URLs (if any) and/or imports the uploaded sheet (if chosen). Keeps the existing project/label/overrides fields.

- [ ] **Step 1: Write failing tests** — choosing a file and creating a run calls the import endpoint with the run id; pasting URLs still enqueues; the standalone Import dialog is gone from `RunsPage`. (Follow existing dialog test patterns; mock the client/file.)
- [ ] **Step 2: Run → FAIL. Step 3: Implement; delete `ImportListDialog` + its test and references. Step 4: Run web suite + build → PASS.**
- [ ] **Step 5: Commit** — `feat(web): merge sheet import into the New Run form`.

---

### Task 8: Web — RunItemsPanel component

**Files:**
- Create: `dashboard/web/src/features/runs/components/RunItemsPanel.tsx` + `.module.scss`
- Test: `dashboard/web/src/features/runs/components/RunItemsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 6 helpers/hooks; `RunItem[]` + the run's content type + running flag.
- `RunItemsPanel({ runId, items, contentType, isRunning, client? })` renders a table: row name/URL, a status badge, an upload badge (image only), the failure `reason` on failed rows, and context actions — **Upload** (completed + not-uploaded image row), **Retry** (failed row), **Open in Drive** (`drive_link`), **Remove** (not-yet-run row, hidden while running). Bulk buttons above: **Upload all pending**, **Retry all failed**. **Paginated** (page size ~50) so large lists stay bounded. Upload/retry/remove disabled while the run is running or (for upload) when the project is text.

- [ ] **Step 1: Write failing tests** — renders status + upload badges per sample items; shows the reason on a failed row; the right action per row state; **a 300-item list renders only one page's worth of rows** *(Review Focus: bounded DOM)*; clicking Upload/Retry/Remove calls the corresponding hook.
- [ ] **Step 2: Run → FAIL. Step 3: Implement component + SCSS. Step 4: Run + build → PASS.**
- [ ] **Step 5: Commit** — `feat(web): run items panel (status/upload/actions, paginated)`.

---

### Task 9: Web — integrate the panel into RunCard

**Files:**
- Modify: `dashboard/web/src/features/runs/components/RunCard.tsx`
- Modify: `dashboard/web/src/features/runs/components/RunCard.module.scss`
- Test: extend `dashboard/web/src/features/runs/components/RunCard.test.tsx`

**Interfaces:**
- Consumes: Task 8 `RunItemsPanel`.
- `RunCard` gains an expandable "Items" section available in EVERY state (not only running). While collapsed it fetches nothing new; when expanded it fetches the run detail (`useRun`) regardless of running state and renders `RunItemsPanel`. The existing live log console stays (running-only); panel + console coexist (tabs or stacked — builder's call). Live `item` events already update the cached detail during a run.

- [ ] **Step 1: Write failing tests** — an "Items" toggle shows on a non-running (e.g. `done`) card; expanding it fetches the detail and renders the panel; the console still appears for a running card. (Use existing RunCard test helpers for cache seeding + socket fake.)
- [ ] **Step 2: Run → FAIL. Step 3: Implement (expand state; fetch detail when expanded; render panel). Step 4: Run web suite + build → PASS.**
- [ ] **Step 5: Commit** — `feat(web): expandable items panel on the run card`.

---

## Self-Review Notes

- **Spec coverage:** unified form → T7; per-item panel (status/upload/reason/actions) → T6/T8/T9; on-demand + bulk upload → T5; retry (item+failed) → T4; remove row → T4; engine scrape-vs-upload split + output/link → T1; persistence → T2/T3; Drive-link coverage on all upload paths → T1 (+T5 record). Non-goal (no recipe editing in the form) respected — T7 only enqueues/imports.
- **Review Focus:** missing output file → T5; Drive not connected → T5; 409 guards → T4/T5; large list bounded → T8; duplicate/idempotent upload → T1/T5.
- **Type consistency:** `outputName`/`uploaded`/`driveLink` flow T1 (engine rec) → T3 (emit + persist) → T6 (`item` event schema) → T8 (render). Store methods `setItemResult(+outputName)`/`setItemUpload`/`deleteItem`/`getItem`/`resetItemsForRetry` defined in T2, consumed in T3/T4/T5. Status contract fixed in Global Constraints, implemented in T6, rendered in T8.
- **CLI safety:** T1's only behavior change is upload-only-failure → `done`+kept files (stated as intended); terminal scraping path otherwise unchanged.
