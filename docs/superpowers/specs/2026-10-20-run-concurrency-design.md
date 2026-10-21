# Run Concurrency — Multiple Runs & Concurrent Rows — Design

**Date:** 2026-10-20
**Status:** Approved (design); plan to follow

## Intent & Why

Today the dashboard scrapes strictly one thing at a time at every level: one
run holds a single in-process slot while all other runs queue, and inside a run
the engine walks its rows one by one in a sequential `for` loop, each row
finishing before the next starts. A run with many rows therefore crawls, and an
operator who has two unrelated batches to scrape must wait for the first to
finish before the second even begins.

This work adds two independent levels of parallelism, both under the operator's
explicit control:

1. **Run-level:** let a second run execute alongside a running one, started
   deliberately by the operator, capped at two at once.
2. **Row-level:** inside a run, scrape several rows concurrently, where the
   number is set per run on the New Run form, with each concurrent row showing
   its own live page-progress in the items table.

The target site the operator scrapes today has proven tolerant (no blocks,
captchas, or throttling observed), so the design's job is not to decide a "safe"
rate automatically — it is to give the operator a dial and sane ceilings so they
stay in control and the laptop this runs on stays healthy.

## Goals

- **Concurrent rows within a run, operator-set.** The New Run form gains a
  **Concurrent rows** number field (default **1** — today's exact sequential
  behavior — min 1, max 5). The engine processes that many rows at once, each in
  its own isolated browser page, each advancing through its own pages
  independently.
- **Per-row live progress in the items table.** While a row is scraping, its
  table row shows a live "pages done / total" progress bar (e.g. `13 / 21
  pages`), reusing the app's existing meter/badge components and styling. On
  completion the row shows its final status/upload state as it does today.
- **Two concurrent runs, operator-started.** The single in-process run slot
  becomes a cap of **2**. A second run runs immediately **only when the operator
  explicitly starts it**; the system never decides on its own to run two.
- **Auto-drain stays one at a time.** The existing FIFO queue continues to
  auto-start the next queued run, but only maintains **one** automatically
  running run. The second concurrent slot is filled *only* by a manual Start.
- **Start disabled at the cap.** When two runs are running, the Start button on
  every other (queued/stopped) run is disabled, and the server rejects a start
  that would exceed the cap (the UI state is backed, not cosmetic).
- **A global row ceiling protects the laptop.** Across all runs combined, no more
  than **6** rows scrape at once (so two runs set to 5 each cannot open ten
  browser tabs — the extra rows wait their turn).
- **Politeness survives concurrency.** The existing per-row inter-item delay and
  the per-host circuit breaker continue to apply; concurrency raises the request
  rate deliberately (that is the operator's chosen tradeoff), it does not silently
  delete the back-off behavior.

## Non-Goals

- **Page-level parallelism inside a single row.** Pages within one row stay
  sequential — a row is one browser tab driven through a virtualized reader by
  key-presses with passive image capture; grabbing multiple pages of the same row
  at once is a separate, much larger rearchitecture and is explicitly out of
  scope. (Confirmed with the user.)
- **Auto-scaling / adaptive concurrency.** The app does not raise or lower
  concurrency based on target health; the operator sets the number. The circuit
  breaker still trips on a failing host as it does today, but it does not tune the
  concurrency dial.
- **Multi-process / distributed execution.** Everything stays in the single
  Fastify server process; the caps are in-process (as the current single-slot
  mutex already is).
- **Multiple Google Drive accounts.** A separate feature discussed earlier; not
  part of this work.
- **Auto-filling the second run slot.** The system never auto-starts a run to
  reach two; two-at-once is always a deliberate operator action.

## Anti-Goals (failure even if it "works")

- Two row-workers claiming and scraping the **same** row (double download, racing
  status writes, duplicate output).
- A per-row progress bar wired to the wrong row — row A's page count rendering on
  row B because progress events aren't keyed by item.
- Concurrent DB writes to `run_items` corrupting or clobbering each other's
  status/result columns.
- A third run slipping past the cap because the limit lived only in the disabled
  button and not in the start path on the server.
- Concurrency quietly erasing the inter-item delay / circuit breaker so the
  operator unknowingly hammers (and gets blocked by) the target.
- Unbounded browser tabs: per-run or global settings that let memory balloon past
  the ceiling and take down the laptop.
- A run left in a stuck state because a crashed/stopped worker never released its
  row slot or never marked its in-flight row.

## Constraints

- Build on the existing stack: Fastify 5 + better-sqlite3 + zod server (Node
  ESM), React 19 + TanStack Query + SCSS-module web, the shared engine
  (`BatchRunner` / `scrapeJob` / `ScrapingOrchestrator` / `ReaderDriver` /
  `ImageCapture`). Tests: `node:test` (server/engine), Vitest (web). Pristine test
  output.
- **In-process, single server process.** The current one-at-a-time limit is a
  module-level variable, not a DB lock or child process; the run-cap and global
  row-ceiling stay in-process too. (Crash recovery already marks interrupted
  `running` runs `failed` on restart — that must still hold for *all* runs that
  were running, now that more than one can be.)
- **better-sqlite3 is synchronous and single-connection.** JS is single-threaded,
  so concurrent row-workers interleave on the event loop but never truly run DB
  writes in parallel; the row-claim and status writes must be designed as
  synchronous, atomic operations so two workers can't be handed the same row.
- Reuse the existing WebSocket hub + `progress` / `item` events; extend them to
  carry an item id rather than inventing a new transport.
- Per-run config still flows `form → createRunSchema.overrides → overrides_json →
  buildRunConfig(recipe, {overrides, driveAuth}) → engine config`. The new
  concurrency setting threads through the same path.
- Migrations are additive (new numbered migration), never edits to existing ones.
- Enforce every cap **server-side** (start route + run manager + global
  semaphore); the disabled Start button is a reflection of server state, not the
  enforcement.

## The How — decisions made

### 1. Run-level concurrency (cap 2, manual second slot)

Replace the single `active` slot in `run-manager.mjs` with a small registry of
active runs (a map keyed by `runId`), plus two constants:

```
MAX_CONCURRENT_RUNS = 2
```

- **`start(runId)`** succeeds (claims a slot and executes) when the number of
  running runs is `< MAX_CONCURRENT_RUNS`; otherwise it leaves the run `queued`
  and returns `"queued"` (as today). A manual Start is thus allowed to take the
  count from 1 → 2.
- **Auto-drain target is 1.** `startNextQueued()` (chained after each run
  finishes) auto-starts the next FIFO queued run **only when zero runs are
  currently running**. This preserves "one at a time by default": the queue
  drains itself one run at a time, and the *second* concurrent run is only ever
  created by an explicit operator Start. (So if a manually-started second run is
  still going when the first finishes, queued runs wait until that second run
  also finishes — matching the user's "only when I start another run" intent.)
- **`stop`** targets a specific run in the registry (today it stops "the" active
  run); each entry keeps its own `BatchRunner` + `stopRequested`.
- **Crash recovery** (`failInterruptedRuns`) already fails *every* `running` run
  on restart — unchanged and still correct with multiple running runs (and now
  also clears stale row claims, per §7).
- **Graceful shutdown** (`server.mjs`) currently stops the single active run and
  awaits one `idle()`; with a registry it must stop **all** running runs and await
  **all** of them before the DB closes, so a second concurrent run still records
  its terminal state on shutdown.

The `runs.state` values and FIFO `nextQueuedRun` (single pick) are unchanged; the
registry simply allows up to two picks to be active.

### 2. Start availability — server-enforced, surfaced in the UI

- The start path (`POST /api/runs/:id/start`, `retry`, `requeue`) asks the run
  manager to start; when already at `MAX_CONCURRENT_RUNS` the run stays `queued`
  and the response says so (no execution). This is the real enforcement.
- The web surfaces a **running-run count** (derivable from the runs list state,
  or a tiny `GET` the manager already can answer) so each `RunCard`'s Start button
  is **disabled when two runs are running** and the card isn't one of them. The
  disabled state must match the server: a start attempt at the cap is a no-op
  queue, not an error toast.
- Builder's call: whether the running count comes from the existing runs-list
  query (states already fetched) or a dedicated endpoint; the contract is that the
  button's enabled/disabled state reflects actual server capacity.

### 3. Row-level concurrency — a bounded worker pool replaces the sequential loop

The sequential `for` over jobs in `BatchRunner._runJobs` (`pipeline.mjs:329`)
becomes a **bounded worker pool** of size `rowConcurrency` (the per-run setting,
default 1 — at 1 the behavior is identical to today):

- Spawn up to `rowConcurrency` workers. Each worker loops: **atomically claim the
  next unclaimed job** from the source, scrape it to completion
  (`scrapeJob` → orchestrator → reader → capture, unchanged per row), persist its
  status/result, emit its `item` event, then claim the next — until the source is
  drained or `_stopping` is set.
- **Atomic claim.** `StoreJobSource` (and the in-memory source) gain a
  synchronous `claimNext()` that returns the next not-done/not-claimed job and
  marks it in-flight in one synchronous step, so two workers never get the same
  row. Because JS is single-threaded and better-sqlite3 is synchronous, a plain
  synchronous "select next + mark" is race-free. The existing skip logic
  (`skipReason` skips `done`/`skip` rows; failed rows are `retry`) still decides
  what's claimable.
- **Isolated browser page per row, lazily created, tied to the global slot.**
  Today one `BrowserSession` is created per run and reused across all rows
  (`pipeline.mjs:295`). Each concurrent row instead needs its **own isolated
  page** so that `ImageCapture`'s `page.on("response")` listener only ever sees
  its own row's images (Playwright's `page.on("response")` / `page.route` are
  already per-page, so a fresh page per row is sufficient — a separate context is
  optional, builder's call). **Decided (resolves the ceiling tension with §4):**
  pages are created **lazily after a worker acquires a global row slot** and
  **torn down when it releases the slot**, so the number of *open* browser pages
  never exceeds `GLOBAL_MAX_CONCURRENT_ROWS` — not just the number actively
  fetching. A run set to concurrency 5 does not pre-open 5 tabs; it opens a tab
  only for each row it is actually permitted to scrape right now. The small cost
  is a page create+navigate per row instead of reusing one page across a worker's
  rows; that is the accepted price of a hard RAM ceiling on a laptop. One browser
  instance per run is fine (cheap to keep); it's *pages* that are bounded.
- **Politeness per worker.** The inter-item delay (`itemDelay`, default 3000ms)
  applies **per worker between the rows it processes** (not globally serialized),
  and worker start is **staggered** by a short offset so N rows don't all hit the
  host on the same tick. The per-host **circuit breaker** stays shared across
  workers (in-process synchronous state); a tripped host short-circuits all
  workers' subsequent rows for that host, as today. Net effect: request rate rises
  with `rowConcurrency` — the operator's intended, controlled tradeoff.
- **Stop:** setting `_stopping` makes workers stop claiming new rows and return
  after their current row finishes; the run then ends `stopped` as today.

### 3a. Cross-run politeness is independent (decided)

Politeness state — the per-host **circuit breaker** and the inter-item delay — stays
**per run** (per `BatchRunner`), not shared across runs. Two runs are coordinated
only by the global row ceiling (§4), which bounds total tabs but not per-host
request rate across runs. **Accepted consequence:** when two runs scrape the *same*
host at once, that host sees roughly double the request rate, and neither run's
breaker sees the other's failures. This is a deliberate, operator-controlled
tradeoff (confirmed with the user): the operator decides when to start a second run
and sets each run's concurrency, the observed target is tolerant, and keeping
control in the operator's hands is the explicit goal. It is therefore *not* a
violation of the "don't silently hammer the target" anti-goal — it is neither
silent (documented here and operator-initiated) nor automatic. A shared,
process-global per-host limiter across runs is a possible later refinement, not part
of this work.

### 4. Global row ceiling (laptop guard)

A single in-process semaphore owned by the run manager caps **total concurrent
rows across all runs**:

```
GLOBAL_MAX_CONCURRENT_ROWS = 6
```

- The manager injects an `acquireRowSlot()` / `releaseRowSlot()` pair (a counting
  semaphore) into each run's engine config. A worker **acquires a slot before
  scraping a row and releases it after** (success or failure). When the global
  count is at 6, a worker waits for a slot before starting its next row.
- Because a worker only creates its browser page *after* acquiring a slot (§3),
  this bounds total **open** scraping tabs to 6 — not merely the number fetching —
  regardless of how the per-run numbers multiply out (two runs × 5 rows requested
  → at most 6 tabs open and scraping at once, the other 4 rows waiting with no tab
  yet). It is the real memory guard on a laptop.
- Builder's call: the exact semaphore implementation (a tiny promise-queue) and
  where it's injected (via `buildRunConfig`/engine config, consistent with how
  `driveAuth` is injected). The contract: total concurrent rows ≤
  `GLOBAL_MAX_CONCURRENT_ROWS`, releases are guaranteed even on error/stop (no slot
  leaks), and at `rowConcurrency = 1` with one run the path is effectively a no-op.

All three numbers (`MAX_CONCURRENT_RUNS`, the form max of 5, and
`GLOBAL_MAX_CONCURRENT_ROWS`) live as named constants in one obvious place so they
are easy to retune.

### 5. Per-row page progress — key progress events by item

Today `ReaderDriver` emits a single run-level live bar via
`logger.progressBar(current, total, "pages")`, folded into one `detail.live` on
the client (`use-run-events.ts`). With N rows live at once, progress must be keyed
by row:

- **Engine:** the `progress` / `progress-end` events gain the **item id** of the
  row they belong to. This means threading the current job's id into the progress
  emission — e.g. a per-row logger/child context created in the worker when it
  starts a job, so `ReaderDriver`'s `progressBar` calls are tagged with that row's
  id. (Builder picks the mechanism — a per-row logger wrapper vs passing the id
  through — the contract is every `progress` event carries which item it is for.)
- **Client:** replace the single `detail.live` with a **map keyed by item id**
  (`detail.liveByItem[itemId] = { current, total }`), cleared on that item's
  `progress-end` / `item` completion. `RunItemsPanel` renders a per-row progress
  bar from this map for rows currently scraping; completed rows fall back to their
  persisted `saved`/`total`. The run-level "X of Y items" meter on the card is
  unchanged (still derived from completed items).
- **Not persisted.** Live page progress stays ephemeral (as today) — only the
  final per-row `saved`/`total` are persisted in `run_items`. Concurrency doesn't
  change what's stored, only that live progress is now per-item rather than a
  single shared bar.

### 6. New Run form field & config threading

- `NewRunDialog` gains a **Concurrent rows** number input (default 1, min 1, max
  5), styled with the app's existing form controls, with helper copy noting "1 =
  sequential (safe); higher is faster but hits the site harder; pages within a row
  still scrape one at a time."
- `buildOverrides()` includes `concurrency` (int). `createRunSchema.overrides`
  gains `concurrency: z.number().int().min(1).max(5)` (optional, default 1).
  Stored in `overrides_json` as today.
- `buildRunConfig` maps it onto the engine config (e.g. `config.rowConcurrency`),
  **clamped** to `[1, 5]` server-side regardless of what the client sends. The
  worker pool (§3) reads it.
- Optional nice-to-have (builder's discretion, mirrors the existing per-project
  Drive-folder memory): remember the last-used concurrency per project in
  localStorage and prefill it.

### 7. Data model

- **No new run-level column is strictly required** — concurrency rides in the
  existing `overrides_json`. (Builder may add a dedicated `runs.concurrency` column
  in an additive migration if it simplifies display/queries; optional.)
- **`run_items`:** an in-flight/claim marker is needed for the atomic
  `claimNext()` so a worker can mark a row "in progress" distinctly from pending.
  **Decided — use a distinct claim column, not the `status` column.** Add an
  additive migration for a nullable claim marker (e.g. `claimed_at TEXT`).
  `claimNext()` synchronously selects the next row that is claimable *and* not
  already claimed (`claimed_at IS NULL`) and stamps `claimed_at` in the same
  synchronous step; the terminal write (`done`/`retry`/`skip`) and the result
  columns are unchanged. This keeps the existing skip/recovery code correct
  **without touching it**, which the current `status`-based paths would otherwise
  break:
  - `skipReason()` treats any non-empty `status` other than `retry`/`done`/`skip`
    as "leave alone" — an `in_progress` *status* would make a crashed row
    permanently skipped. A separate `claimed_at` avoids that: `status` stays `""`
    for a claimed-but-unfinished row, so it remains claimable after a reset.
  - `deriveItemStatus()` / `run-summary.itemStatus()` stay unchanged (a claimed
    row with no `saved`/`reason` still reads as "pending", which is correct for
    display).
  - **Recovery of stale claims (required):** `failInterruptedRuns()` (on restart)
    and the requeue/retry paths must **clear `claimed_at`** for the affected run's
    rows so a worker that died mid-row leaves no permanently-stuck claim. (Today
    `failInterruptedRuns` only flips the `runs` row to `failed` and `resetFailedItems`
    only touches `status='retry'` rows — both must also null out `claimed_at` on
    the run's rows.) This directly discharges the anti-goal "a run left in a stuck
    state because a crashed/stopped worker never released its row slot or never
    marked its in-flight row."

## Left to the builder

- The run-registry data structure and the precise auto-drain predicate
  implementing "auto-drain maintains at most one running run; second slot is
  manual only; hard cap 2."
- Where the running-run count is sourced for the Start-button disabling
  (existing list query vs a small endpoint).
- The worker-pool implementation (hand-rolled vs a tiny `p-limit`-style helper —
  no heavy dep), the atomic `claimNext()` on both job sources, and the browser
  isolation unit (context vs page) per worker.
- The global row-semaphore implementation and its injection point; guaranteeing
  slot release on every path (success, scrape error, upload error, stop, crash).
- The per-row progress-event keying mechanism (per-row logger vs threaded id) and
  the client `liveByItem` shape + `RunItemsPanel` per-row bar rendering.
- Whether to add a `runs.concurrency` column and/or a distinct `run_items`
  in-progress marker vs reusing `status`.
- The New Run form field layout/copy and the optional per-project concurrency
  memory.
- How `itemDelay` staggering is applied across workers, and confirming the
  circuit breaker's shared state is safe under concurrent access (it is, in-process
  synchronous — verify no awaited gaps corrupt it).
- Tests (TDD): atomic claim never double-issues a row; pool of N truly runs N at
  once and respects the global ceiling; `rowConcurrency=1` is byte-for-byte the old
  sequential behavior; slot/semaphore released on error & stop; run cap of 2 and
  manual-only second slot; auto-drain keeps to one; Start disabled at cap
  (server-enforced); per-row progress events carry the right item id and render on
  the right row; schema clamps concurrency to [1,5].

## Key files (orientation)

- Engine: `src/pipeline.mjs` (`_runJobs` loop → worker pool, `scrapeJob`,
  `onItem`, `BrowserSession` creation), `src/orchestrator.mjs`, `src/reader.mjs`
  (progress emission), `src/capture.mjs` (per-page isolation), `src/sources.mjs`
  (`StoreJobSource` → atomic `claimNext`), `src/config.mjs` (`itemDelay`,
  concurrency default), `src/events/event-logger.mjs` (progress events get item
  id).
- Server: `dashboard/server/src/run-manager.mjs` (registry, cap, auto-drain,
  global semaphore), `routes/runs.mjs` (start path enforcement, running count),
  `build-run-config.mjs` (`concurrency` → engine config), `schemas.mjs`
  (`createRunSchema.overrides.concurrency`), `hub.mjs` / `routes/ws.mjs` (event
  passthrough), `db/{migrations,store}.mjs` (optional column, claim write).
- Web: `features/runs/components/{NewRunDialog,RunCard,RunItemsPanel}.tsx`,
  `features/runs/hooks/{use-run-events,use-run-progress}.ts`,
  `features/runs/{api/runs-api.ts,types.ts}`, `lib/schemas.ts`.
