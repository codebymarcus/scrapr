# Run Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator run up to two scrape runs at once (second started manually) and scrape several rows per run concurrently, set per run on the New Run form, with a live per-row page-progress bar in the items table.

**Architecture:** Three in-process levers, all bounded by named constants. (1) The engine's sequential per-row loop (`BatchRunner._runJobs`) becomes a bounded worker pool whose size is the run's `rowConcurrency`; each worker claims the next row via a shared synchronous cursor (atomic in single-threaded JS — no DB claim marker), opens its own browser page (the existing per-row path already does), scrapes, and persists. (2) The run manager's single `active` slot becomes a registry capped at `MAX_CONCURRENT_RUNS`; the queue auto-drains to one running run, and the second slot is only ever filled by an explicit Start. (3) A single run-manager-owned counting semaphore caps total concurrent rows across all runs at `GLOBAL_MAX_CONCURRENT_ROWS`, injected into every run's engine so open browser pages never exceed the ceiling. Progress events gain an item id so the UI keys a live page bar per row.

**Tech Stack:** Node ESM engine (Playwright), Fastify 5 + better-sqlite3 dashboard server, React 19 + TanStack Query + SCSS-module web. Tests: `node:test` (engine/server), Vitest (web).

**Spec:** `docs/superpowers/specs/2026-10-20-run-concurrency-design.md`

## Global Constraints

- **Constants (exact values), each a named export in one obvious place:** `MAX_CONCURRENT_RUNS = 2` and `GLOBAL_MAX_CONCURRENT_ROWS = 6` (server, `run-manager.mjs`); row-concurrency form bounds `MIN = 1`, `MAX = 5`, default `1` (web + server schema clamp + engine default).
- **`rowConcurrency` default is 1 and at 1 the engine behavior is byte-for-byte identical to today** (sequential, same ordering, same `itemDelay` pacing). This is a hard acceptance criterion, not a goal.
- **In-process only.** No new process/child/worker-thread. better-sqlite3 is synchronous and single-connection; all row-claim and status writes stay synchronous. JS is single-threaded — a shared cursor increment with no `await` between read and increment is the atomic claim.
- **Caps enforced server-side**, not only in the disabled button: a start at the cap leaves the run `queued` (existing `runManager.start` return `"queued"`), never executes.
- **Politeness is per run** (decided, spec §3a): the circuit breaker and `itemDelay` stay per `BatchRunner`; two runs on the same host independently pace (accepted double rate). Do **not** add cross-run throttling.
- **No `claimed_at` column / no migration** (supersedes spec §7): the in-memory shared cursor provides atomic claim within a run, and a crashed row keeps its blank `status` so it re-scrapes on resume exactly as today. Nothing new is persisted for claiming.
- Additive-only if any migration is ever added (none is required by this plan).
- Pristine test output; follow existing file patterns and the SCSS-module/atoms component conventions.

## Review Focus

- **Global slot leak on error:** a row whose scrape throws (or whose upload throws) must still release its semaphore slot — otherwise the ceiling erodes run-by-run until nothing scrapes. Test owns Task 4.
- **Stop with rows in flight:** when `stop()` fires mid-run with N rows scraping, in-flight rows finish, no new rows are claimed, the run ends `stopped`, and unclaimed rows stay resumable (blank status). Test owns Task 2.
- **Out-of-range concurrency from the client:** a `concurrency` of 0, NaN, 99, or a non-integer must be clamped to `[1,5]` server-side regardless of what the form or a raw API caller sends (`buildRunConfig` clamps even what the schema would reject). Test owns Task 1.
- **Concurrent text-record corruption:** in pattern/selector text mode, concurrent rows share one `RecordWriter`; unserialized `append()` calls can drop or interleave records. Appends must be serialized. Test owns Task 2.
- **Ceiling holds across two runs:** two independent `BatchRunner`s sharing one limiter must never exceed `GLOBAL_MAX_CONCURRENT_ROWS` concurrent scrapes combined. Test owns Task 4.

---

## Task 1: Engine config — `rowConcurrency` default + per-run threading

**Files:**
- Modify: `src/config.mjs` (DEFAULTS, ~line 50)
- Modify: `dashboard/server/src/build-run-config.mjs:44-86`
- Modify: `dashboard/server/src/schemas.mjs:91-100` (createRunSchema.overrides)
- Test: `dashboard/server/test/build-run-config.test.mjs` (extend/create), `dashboard/server/test/schemas.test.mjs` (extend/create)

**Interfaces:**
- Produces: `config.rowConcurrency: number` on the engine config (always set, 1–5). `createRunSchema` accepts `overrides.concurrency?: number` (int 1–5). Consumed by Task 2 (pool size) and Task 7 (web type).

- [ ] **Step 1: Write the failing tests**

```js
// build-run-config.test.mjs
test("rowConcurrency comes from overrides.concurrency, clamped to [1,5]", () => {
  const img = buildRunConfig(imageRecipe, { runOutDir: "/x", overrides: { concurrency: 3 } });
  assert.equal(img.rowConcurrency, 3);
  assert.equal(buildRunConfig(imageRecipe, { runOutDir: "/x", overrides: { concurrency: 99 } }).rowConcurrency, 5);
  assert.equal(buildRunConfig(imageRecipe, { runOutDir: "/x", overrides: { concurrency: 0 } }).rowConcurrency, 1);
});
test("rowConcurrency defaults to 1 and applies to text runs too (overrides otherwise ignored)", () => {
  assert.equal(buildRunConfig(imageRecipe, { runOutDir: "/x", overrides: {} }).rowConcurrency, 1);
  const text = buildRunConfig(textRecipe, { runOutDir: "/x", overrides: { concurrency: 4, drive: true } });
  assert.equal(text.rowConcurrency, 4);
  assert.notEqual(text.drive, true); // drive override still ignored for text
});
// schemas.test.mjs
test("createRunSchema accepts concurrency 1..5 and rejects out-of-range/non-int", () => {
  assert.ok(parseOr400(createRunSchema, { projectId: 1, overrides: { concurrency: 5 } }).ok);
  assert.equal(parseOr400(createRunSchema, { projectId: 1, overrides: { concurrency: 6 } }).ok, false);
  assert.equal(parseOr400(createRunSchema, { projectId: 1, overrides: { concurrency: 2.5 } }).ok, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test dashboard/server/test/build-run-config.test.mjs dashboard/server/test/schemas.test.mjs`
Expected: FAIL (`rowConcurrency` undefined; concurrency key stripped/accepted wrongly).

- [ ] **Step 3: Implement**

- `src/config.mjs`: add `rowConcurrency: 1` to DEFAULTS (pacing group).
- `schemas.mjs`: add `concurrency: z.number().int().min(1).max(5).optional()` to the `createRunSchema.overrides` object.
- `build-run-config.mjs`: in `buildRunConfig`, after building the base `config` and **before** the `recipe.builtIn` / text / image branches, set `config.rowConcurrency = clampConcurrency(overrides?.concurrency)` where `clampConcurrency(n)` returns `1` when `n` is not a finite number, else `Math.min(5, Math.max(1, Math.round(n)))`. (Setting it before the text early-return is why text runs honor concurrency while still ignoring drive/format.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test dashboard/server/test/build-run-config.test.mjs dashboard/server/test/schemas.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs dashboard/server/src/build-run-config.mjs dashboard/server/src/schemas.mjs dashboard/server/test/build-run-config.test.mjs dashboard/server/test/schemas.test.mjs
git commit -m "feat(engine): thread per-run rowConcurrency through run config + schema"
```

---

## Task 2: Engine — bounded row worker pool in `BatchRunner`

**Files:**
- Modify: `src/pipeline.mjs:325-413` (`_runJobs`; extract `_runOneJob`)
- Test: `test/pipeline-concurrency.test.mjs` (create)

**Interfaces:**
- Consumes: `config.rowConcurrency` (Task 1). Existing injectable deps on `BatchRunner` (`_scrapeJob`, `_scrapeText`, `createJobSource`, `_onItem`, `resolveProfile`).
- Produces: `BatchRunner._runOneJob(job, index, total, ctx)` → `Promise<{ rec, scraped }>` where `ctx = { source, session, processor, packagers, uploader, breaker }`. `_runJobs` returns the per-row `results` as today (order-preserving, skipped entries included). Used by Tasks 3, 4.

**Approach:** Extract the entire per-row body of the current `for` loop into `_runOneJob` (skip checks, breaker trip check, `itemDelay`+backoff wait, profile resolve, text vs image scrape, `breaker.record`, `source.setStatus/setReason`, `this._onItem`). Then `_runJobs` spawns `n = clamp(config.rowConcurrency, 1, jobs.length)` workers sharing a synchronous cursor `let next = 0` (`const i = next++;` is the atomic claim — no `await` between read and increment). Each worker loops: claim `i`; stop if `i >= jobs.length` or `this._stopping`; `results[i] = (await this._runOneJob(...)).rec`. `await Promise.all(workers)`. `itemDelay`: each worker tracks its own `scrapedAny` (first claimed row no delay, later rows delayed) — pass it into `_runOneJob` and fold the returned `scraped`. Serialize `RecordWriter.append` by chaining on a single `this._recordTail = this._recordTail.then(() => writer.append(r))` promise (guards the shared writer under concurrency; at concurrency 1 it is a trivial chain). Stop logging: after the pool settles, if `this._stopping`, log how many rows were never claimed (`jobs.length - claimedCount`).

- [ ] **Step 1: Write the failing tests** (inject a barrier `_scrapeJob` that records max observed overlap)

```js
// pipeline-concurrency.test.mjs — build a BatchRunner with createJobSource returning N fake jobs,
// a fake synchronous status store (hasStatus:true), and an injected _scrapeJob that increments a
// shared `inFlight`, awaits a tick, records `maxInFlight`, decrements, returns { complete:true, saved:1, total:1 }.
test("rowConcurrency=1 processes rows one at a time, in order", async () => {
  const { maxInFlight, order } = await runWith({ rowConcurrency: 1, jobs: 5 });
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, [0,1,2,3,4]);
});
test("rowConcurrency=3 runs up to 3 rows at once and processes each exactly once", async () => {
  const { maxInFlight, processedIds } = await runWith({ rowConcurrency: 3, jobs: 9 });
  assert.equal(maxInFlight, 3);
  assert.equal(new Set(processedIds).size, 9); // none double-claimed, none missed
});
test("stop mid-run: in-flight finish, remaining rows left unprocessed", async () => {
  // _scrapeJob calls runner.stop() when it starts job index 2.
  const { processedIds } = await runWith({ rowConcurrency: 2, jobs: 10, stopAtIndex: 2 });
  assert.ok(processedIds.length < 10);
  // every non-processed job still has blank status in the fake store (resumable)
});
test("concurrent text-record appends are serialized (no lost records)", async () => {
  // text recipe, rowConcurrency=4, 20 rows; assert RecordWriter.count === 20 at the end.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/pipeline-concurrency.test.mjs`
Expected: FAIL (`_runOneJob` undefined / sequential behavior gives maxInFlight 1 at concurrency 3).

- [ ] **Step 3: Implement `_runOneJob` and the worker pool in `src/pipeline.mjs`** per the Approach above. Keep `skipReason`, breaker, delay, status/reason writes, and `onItem` semantics unchanged — only their location moves and the loop becomes a pool.

- [ ] **Step 4: Run tests to verify they pass** (and the existing pipeline tests still pass)

Run: `node --test test/pipeline-concurrency.test.mjs test/pipeline*.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.mjs test/pipeline-concurrency.test.mjs
git commit -m "feat(engine): scrape rows concurrently via a bounded worker pool"
```

---

## Task 3: Engine — per-row progress events carry an item id

**Files:**
- Modify: `src/events/event-logger.mjs` (add `forItem`)
- Modify: `src/pipeline.mjs` (`_runOneJob` builds and threads a per-row logger)
- Test: `test/event-logger.test.mjs` (extend/create)

**Interfaces:**
- Consumes: `_runOneJob` (Task 2).
- Produces: `logger.forItem(itemId)` → a logger whose `progressBar`/`endProgress` emit `{ type:"progress"|"progress-end", itemId, ... }`; all other methods delegate unchanged. When the base logger lacks `forItem` (CLI `createLogger`), `_runOneJob` falls back to the shared logger (progress simply carries no itemId). Consumed by Task 9 (web).

- [ ] **Step 1: Write the failing test**

```js
// event-logger.test.mjs
test("forItem stamps progress events with the item id", () => {
  const events = [];
  const log = createEventLogger((e) => events.push(e));
  log.forItem(42).progressBar(3, 10, "pages");
  log.forItem(42).endProgress();
  assert.deepEqual(events[0], { type: "progress", itemId: 42, current: 3, total: 10, label: "pages", ts: events[0].ts });
  assert.equal(events[1].type, "progress-end");
  assert.equal(events[1].itemId, 42);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/event-logger.test.mjs`
Expected: FAIL (`log.forItem is not a function`).

- [ ] **Step 3: Implement**

- `event-logger.mjs`: add `log.forItem = (itemId) => ({ ...log, progressBar: (current,total,label="",...rest) => { send({type:"progress", itemId, current, total, label, ts:Date.now()}); tee("progressBar",[current,total,label,...rest]); }, endProgress: () => { send({type:"progress-end", itemId, ts:Date.now()}); tee("endProgress",[]); } });` (reuses the closure's `send`/`tee`).
- `pipeline.mjs` `_runOneJob`: `const rowLogger = this.logger.forItem?.(job.id) ?? this.logger;` and use `rowLogger` where the per-row scrape path is constructed — build the `ScrapingOrchestrator` with `rowLogger`, pass `rowLogger` to `this._scrapeJob(...)` and `this._scrapeText(...)`. Section/skip/muted logs may stay on `this.logger`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/event-logger.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/events/event-logger.mjs src/pipeline.mjs test/event-logger.test.mjs
git commit -m "feat(engine): key page-progress events by item id for concurrent rows"
```

---

## Task 4: Engine + server — global row-slot semaphore

**Files:**
- Create: `dashboard/server/src/row-limiter.mjs`
- Modify: `src/pipeline.mjs` (`_runOneJob` acquires/releases a slot around the scrape; `BatchRunner` reads `deps.rowLimiter`)
- Modify: `dashboard/server/src/run-manager.mjs` (own one limiter; inject into deps)
- Test: `dashboard/server/test/row-limiter.test.mjs` (create), extend `test/pipeline-concurrency.test.mjs`

**Interfaces:**
- Produces: `createRowLimiter(max)` → `{ acquire(): Promise<() => void>, inUse(): number }` (acquire resolves with a release fn; resolves immediately while `inUse < max`, else queues FIFO). `BatchRunner` gains `deps.rowLimiter` (default a no-op limiter: `acquire` resolves immediately with a no-op release). `run-manager` constructs one limiter at factory scope with `GLOBAL_MAX_CONCURRENT_ROWS` and passes it in `deps.rowLimiter` for every run.
- Consumes: the worker pool (Task 2).

- [ ] **Step 1: Write the failing tests**

```js
// row-limiter.test.mjs
test("limiter never lets more than max run at once; releases unblock the queue", async () => {
  const lim = createRowLimiter(2);
  const rel = [await lim.acquire(), await lim.acquire()];
  assert.equal(lim.inUse(), 2);
  let third = false; lim.acquire().then((r) => { third = true; r(); });
  await Promise.resolve(); assert.equal(third, false); // blocked at the cap
  rel[0](); await Promise.resolve(); await Promise.resolve(); assert.equal(third, true);
});
// pipeline-concurrency.test.mjs
test("a shared limiter bounds total concurrent scrapes across two runners", async () => {
  const lim = createRowLimiter(2);
  // two BatchRunners, each rowConcurrency=3, each 6 jobs, both injected with the SAME lim and a
  // shared maxInFlight counter in their _scrapeJob; run both to completion concurrently.
  assert.equal(observedMaxInFlight, 2);
});
test("a row that throws still releases its slot", async () => {
  // _scrapeJob throws for one job; assert lim.inUse() returns to 0 after the run.
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test dashboard/server/test/row-limiter.test.mjs test/pipeline-concurrency.test.mjs`
Expected: FAIL (module missing; no gating across runners).

- [ ] **Step 3: Implement**

- `row-limiter.mjs`: a counting semaphore with a FIFO waiter queue; `acquire()` returns a release that is idempotent (guard against double-release) and pulls the next waiter.
- `pipeline.mjs`: `this._rowLimiter = deps.rowLimiter || { acquire: async () => () => {} }`. In `_runOneJob`, wrap only the actual scrape work: `const release = await this._rowLimiter.acquire(); try { ...resolve profile + scrape... } finally { release(); }`. Acquire **after** the skip/breaker-trip short-circuits (a skipped row needs no slot) and after the `itemDelay` wait is fine either way; keep the page-opening scrape inside the slot so open pages ≤ ceiling.
- `run-manager.mjs`: `const rowLimiter = createRowLimiter(GLOBAL_MAX_CONCURRENT_ROWS);` at factory scope (export the constant here); add `rowLimiter` to the `deps` object built in `execute()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test dashboard/server/test/row-limiter.test.mjs test/pipeline-concurrency.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/row-limiter.mjs src/pipeline.mjs dashboard/server/src/run-manager.mjs dashboard/server/test/row-limiter.test.mjs test/pipeline-concurrency.test.mjs
git commit -m "feat(server): cap total concurrent rows across runs with a shared semaphore"
```

---

## Task 5: Server — multi-run registry, cap, manual-only second slot

**Files:**
- Modify: `dashboard/server/src/run-manager.mjs:17-214`
- Test: `dashboard/server/test/run-manager.test.mjs` (extend)

**Interfaces:**
- Produces: run manager behavior — `start(runId)` executes when `runningCount() < MAX_CONCURRENT_RUNS`, else returns `"queued"`; `startNextQueued()` auto-starts the next FIFO queued run **only when `runningCount() === 0`**; `stop(runId)` targets that run in the registry; new `activeRunIds(): number[]`; `idle()` resolves when all active runs have settled. `activeRunId()` kept (returns the first active id or null) for back-compat. Consumed by Task 6.

**Approach:** Replace `let active`/`let current` with `const active = new Map()` (runId → `{ runId, runner, stopRequested, promise }`). `runningCount()` = `active.size`. `start`: if at cap, keep queued (as the existing `active`-branch does). Claim a slot by setting `active.set(runId, entry)` synchronously; `execute().finally(() => active.delete(runId))`; chain `startNextQueued()` after. `startNextQueued`: `if (draining || active.size > 0) return null;` then pick `nextQueuedRun`. `idle()`: loop while any entry has an unsettled promise, awaiting `Promise.allSettled([...])`.

- [ ] **Step 1: Write the failing tests**

```js
// run-manager.test.mjs (with a fake store + instant fake runnerFactory)
test("two runs can be active at once; a third start stays queued", async () => {
  // start run A (blocks on a gate), start run B (blocks) -> both running;
  // start run C -> returns "queued" and C's state stays queued.
});
test("auto-drain fills only one slot; the second is manual-only", async () => {
  // queue A,B,C. start A -> running. Let A finish. Assert exactly one of B/C auto-started (running),
  // and the other stays queued (auto-drain did NOT reach two).
});
test("stop targets the named run; the other keeps running", async () => { /* ... */ });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test dashboard/server/test/run-manager.test.mjs`
Expected: FAIL (single-slot forces the 2nd concurrent start to queue).

- [ ] **Step 3: Implement** the registry + cap + `runningCount`-gated auto-drain + `stop(runId)` + `activeRunIds()` + all-aware `idle()`, per the Approach.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test dashboard/server/test/run-manager.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/run-manager.mjs dashboard/server/test/run-manager.test.mjs
git commit -m "feat(server): allow two concurrent runs with a manual-only second slot"
```

---

## Task 6: Server — shutdown stops all running runs

**Files:**
- Modify: `dashboard/server/src/server.mjs:94-107`
- Test: `dashboard/server/test/run-manager.test.mjs` (a `shutdown drains all` case) or a focused server test

**Interfaces:**
- Consumes: `runManager.activeRunIds()` + `idle()` (Task 5).

- [ ] **Step 1: Write the failing test** — with two active runs, the shutdown routine stops both and `idle()` resolves after both settle (assert both reached a terminal state).

- [ ] **Step 2: Run it to verify it fails** (`activeRunId()` only stops one).

Run: `node --test dashboard/server/test/run-manager.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement** — in `shutdown()`, replace the single `activeRunId()` block with: `for (const id of runManager.activeRunIds()) runManager.stop(id);` then race `runManager.idle()` against the existing timeout.

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test dashboard/server/test/run-manager.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/server/src/server.mjs dashboard/server/test/run-manager.test.mjs
git commit -m "fix(server): stop every running run on graceful shutdown"
```

---

## Task 7: Web — types & schema (concurrency override + progress itemId)

**Files:**
- Modify: `dashboard/web/src/features/runs/api/runs-api.ts:124-128` (`RunOverrides`)
- Modify: `dashboard/web/src/lib/schemas.ts:200-208` (`runEventSchema` progress + progress-end)
- Modify: `dashboard/web/src/features/runs/types.ts:44-63` (`CachedRunDetail`)
- Test: `dashboard/web/src/lib/schemas.test.ts` (extend/create)

**Interfaces:**
- Produces: `RunOverrides.concurrency?: number`; `runEventSchema` progress/`progress-end` gain `itemId: z.number().optional()`; `CachedRunDetail.liveByItem?: Record<number, LiveProgress>` (keep `LiveProgress`; remove the single `live` field). Consumed by Tasks 8, 9, 10.

- [ ] **Step 1: Write the failing test**

```ts
// schemas.test.ts
it("parses a progress event with an itemId", () => {
  const e = runEventSchema.parse({ type: "progress", itemId: 7, current: 2, total: 5 });
  expect(e).toMatchObject({ type: "progress", itemId: 7 });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir dashboard/web test -- schemas` (or the repo's web test command)
Expected: FAIL (itemId stripped by the schema).

- [ ] **Step 3: Implement** — add `concurrency?: number` to `RunOverrides`; add `itemId: z.number().optional()` to the two progress variants; change `CachedRunDetail` to `liveByItem?: Record<number, LiveProgress>`.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --dir dashboard/web test -- schemas`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/web/src/features/runs/api/runs-api.ts dashboard/web/src/lib/schemas.ts dashboard/web/src/features/runs/types.ts dashboard/web/src/lib/schemas.test.ts
git commit -m "feat(web): add concurrency override + per-item progress to types/schema"
```

---

## Task 8: Web — "Concurrent rows" field on the New Run form

**Files:**
- Modify: `dashboard/web/src/features/runs/components/NewRunDialog.tsx`
- Create: `dashboard/web/src/features/runs/constants.ts` (`MAX_CONCURRENT_RUNS = 2`, `ROW_CONCURRENCY_MIN = 1`, `ROW_CONCURRENCY_MAX = 5`)
- Test: `dashboard/web/src/features/runs/components/NewRunDialog.test.tsx` (extend/create)

**Interfaces:**
- Consumes: `RunOverrides.concurrency` (Task 7). Produces: the dialog sends `overrides.concurrency` for **all** run types (image and text).

- [ ] **Step 1: Write the failing test** — render the dialog, set Concurrent rows to 3, submit; assert `createRun` was called with `overrides.concurrency === 3`; for a text project, assert concurrency is still sent (no drive keys).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir dashboard/web test -- NewRunDialog`
Expected: FAIL (no field; `buildOverrides` returns undefined for text).

- [ ] **Step 3: Implement** — add a `concurrency` number state (default 1) and a `Field` with a number `TextInput` (min 1, max 5, styled like the existing fields), placed **outside** the `showDrive` section with helper copy: "1 = sequential (safe). Higher scrapes more rows at once — faster, but hits the site harder. Pages within a row still scrape one at a time." Rework `buildOverrides()` to start from `{}`, always include `concurrency` when it differs from 1 (or always include it — either is fine as the server clamps), add the drive keys only when `showDrive`, and return `undefined` only when the object is empty.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --dir dashboard/web test -- NewRunDialog`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/web/src/features/runs/components/NewRunDialog.tsx dashboard/web/src/features/runs/constants.ts dashboard/web/src/features/runs/components/NewRunDialog.test.tsx
git commit -m "feat(web): add Concurrent rows field to the New Run form"
```

---

## Task 9: Web — per-row live page progress in the items table

**Files:**
- Modify: `dashboard/web/src/features/runs/hooks/use-run-events.ts:46-92` (fold progress into `liveByItem`; clear on `progress-end`/`item`)
- Modify: `dashboard/web/src/features/runs/components/RunCard.tsx:227-233` (pass `liveByItem` down)
- Modify: `dashboard/web/src/features/runs/components/RunItemsPanel.tsx` (+ its `.module.scss`) — add a Progress column with a per-row bar
- Test: `dashboard/web/src/features/runs/hooks/use-run-events.test.ts`, `dashboard/web/src/features/runs/components/RunItemsPanel.test.tsx`

**Interfaces:**
- Consumes: `progress`/`progress-end` with `itemId` (Task 7). Produces: `RunItemsPanel` renders a page-progress bar for rows present in `liveByItem`.

- [ ] **Step 1: Write the failing tests**

```ts
// use-run-events.test.ts
it("folds progress into liveByItem keyed by itemId and clears on progress-end", () => {
  // seed a cached detail with items [{id:7}], apply {type:'progress',itemId:7,current:3,total:9}
  // -> detail.liveByItem[7] === {current:3,total:9}; then progress-end{itemId:7} -> entry removed.
});
it("clears an item's live entry when its item completion event arrives", () => { /* ... */ });
// RunItemsPanel.test.tsx
it("shows a per-row page progress bar for a scraping row", () => {
  // liveByItem={{7:{current:13,total:21}}} -> row 7 shows "13 / 21 pages" and a meter at ~62%.
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --dir dashboard/web test -- use-run-events RunItemsPanel`
Expected: FAIL (single `live`; no Progress column).

- [ ] **Step 3: Implement**

- `use-run-events.ts`: `progress` → set `liveByItem[event.itemId] = {current,total,label}` (ignore when no itemId); `progress-end` → delete `liveByItem[event.itemId]`; in the `item` case also delete `liveByItem[event.id]` (row finished). Build on the immutable `setQueryData` pattern already used.
- `RunCard.tsx`: pass `liveByItem={detail.data?.liveByItem}` into `RunItemsPanel`.
- `RunItemsPanel.tsx`: add a `liveByItem?: Record<number, {current:number;total:number}>` prop and a "Progress" column; for a row with a live entry render the existing `SegmentedMeter` (or the app's bar atom) at `current/total` with a `"{current} / {total} pages"` caption; rows without a live entry show nothing (completed rows already show status/upload). Keep columns responsive to `isImage`.

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --dir dashboard/web test -- use-run-events RunItemsPanel`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/web/src/features/runs/hooks/use-run-events.ts dashboard/web/src/features/runs/components/RunCard.tsx dashboard/web/src/features/runs/components/RunItemsPanel.tsx dashboard/web/src/features/runs/components/RunItemsPanel.module.scss dashboard/web/src/features/runs/hooks/use-run-events.test.ts dashboard/web/src/features/runs/components/RunItemsPanel.test.tsx
git commit -m "feat(web): show live per-row page progress in the items table"
```

---

## Task 10: Web — disable Start/Resume at the run cap

**Files:**
- Modify: `dashboard/web/src/features/runs/components/RunsPage.tsx:149-161` (compute `atRunCap`, pass down)
- Modify: `dashboard/web/src/features/runs/components/RunCard.tsx:28-56,136-157` (accept `startDisabled`, apply to Start + Resume)
- Test: `dashboard/web/src/features/runs/components/RunCard.test.tsx` (extend)

**Interfaces:**
- Consumes: `MAX_CONCURRENT_RUNS` (Task 8 constants) and `groups.running.length` (already in RunsPage).

- [ ] **Step 1: Write the failing test** — render a `RunCard` for a queued run with `startDisabled`; assert the Start button is disabled; render without it; assert enabled.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --dir dashboard/web test -- RunCard`
Expected: FAIL (no such prop).

- [ ] **Step 3: Implement** — `RunCard` gains `startDisabled?: boolean`; apply `disabled={busy || startDisabled}` to both Start and Resume buttons; optionally a title/tooltip "Two runs are already running". `RunsPage.renderCards`: compute `const atRunCap = groups.running.length >= MAX_CONCURRENT_RUNS;` and pass `startDisabled={atRunCap}`.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --dir dashboard/web test -- RunCard`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard/web/src/features/runs/components/RunsPage.tsx dashboard/web/src/features/runs/components/RunCard.tsx dashboard/web/src/features/runs/components/RunCard.test.tsx
git commit -m "feat(web): disable Start/Resume when two runs are already running"
```

---

## Notes for the executor

- **Run the real app once at the end** (`skill: run` or the dashboard's dev command): start two runs manually (confirm the second runs alongside and a third's Start is disabled), set Concurrent rows to 3 on a multi-row run, and watch three per-row page bars advance at once. Tests cover the logic; this confirms the wiring end to end.
- Web test command: use whatever the repo already uses (Vitest) — the `pnpm --dir dashboard/web test -- <pattern>` lines above are a placeholder for the project's actual invocation; match `dashboard/web/package.json`.
