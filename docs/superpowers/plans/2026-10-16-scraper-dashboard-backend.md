# Scraper Dashboard — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Node server that owns the dashboard's queue (SQLite), drives the existing scraper engine in-process (one run at a time) with live progress over WebSocket, and exposes a typed HTTP API for projects/recipes, runs, no-write page previews, thumbnails, and Drive status.

**Architecture:** A new `dashboard/server/` ESM app with its own `package.json`. It imports the engine from the repo root (`../../src/...`). Every side-effecting collaborator (the SQLite store, the `BatchRunner`, the browser session, `fetch`, the clock) is injected, so routes, the run manager, and the store are unit-testable with `node --test` and Fastify's `app.inject()` — no real browser, network, or long-lived process in tests. SQLite access is **synchronous** (`better-sqlite3`), which satisfies the engine-seams carry-forward that the store must write synchronously.

**Tech Stack:** Node ESM. `fastify` + `@fastify/websocket` (HTTP + WS), `better-sqlite3` (synchronous SQLite), `zod` (validate every request body and every recipe). `node --test` + `app.inject()`. Imports the merged engine seams: `BatchRunner`, `StoreJobSource`, `recipeToProfile`/`imageRulesFromRecipe`/`boundResolver`, `createEventLogger`, `previewText`, `imagePreview`/`collectCandidateImages`, `filterImages`/`runtimeUnenforcedImageRuleKeys`, `needsReview`, `DEFAULTS`, `createJobSource`, `SheetSource`, `BrowserSession`, `DriveUploader`.

**Spec:** `docs/superpowers/specs/2026-10-16-scraper-dashboard-design.md` (§5.2, §7, §8). Engine plan: `docs/superpowers/plans/2026-10-16-scraper-dashboard-engine-seams.md` (now merged to `main`).

## Global Constraints

- Node ESM, named exports, 2-space indent, double quotes, trailing commas (match the repo).
- `dashboard/server/` has its own `package.json`; engine is imported by relative path (`../../src/...`), never copied.
- All remote/engine side effects are injected (store, runner factory, browser session, `fetch`, `now`) so tests need no browser/network/real process.
- **Single active run** (spec §8.1): the run manager runs at most one run at a time; others stay queued.
- **Recipe is bound per-run** (spec §8.1): a run references one recipe id; the engine resolves via `boundResolver(recipe)`, not URL matching.
- **Sync store contract** (engine carry-forward): `store.setItemStatus`/`setItemReason` are synchronous (`better-sqlite3`), so `StoreJobSource`'s write-swallow works and no rejection escapes.
- **WS `emit` is synchronous** (engine carry-forward): the function passed to `createEventLogger` must not return a rejecting Promise; it does a synchronous in-memory broadcast.
- **Image selector/position rules are preview-only** (engine carry-forward): the run honors only URL/bytes + min-width/height; the API must call `runtimeUnenforcedImageRuleKeys(recipe.image.rules)` and return the inert keys so the UI can warn. Never present selector/position image rules as enforced at run.
- The SQLite file and any downloaded output live under a git-ignored data dir; add it to `.gitignore`.
- No secrets in URLs/query strings; Drive OAuth is **not** performed here — the API only reports status and points the user to `node authorize.mjs`.

## Review Focus

- **A second "start run" while one is active** → the new run is queued, not run concurrently (one browser session at a time). Pinned in Task 8.
- **Stopping a run mid-flight** → `runner.stop()` is called, the current item finishes, remaining items stay resumable, and the run ends in a `stopped` (not `failed`) state. Pinned in Task 8.
- **A recipe carrying `includeSelector`/`excludeSelector`/`position` image rules** → the run still starts, those keys are reported as unenforced, and nothing claims they applied. Pinned in Task 10.
- **An invalid request body** (bad recipe JSON, unknown enum, missing url) → 400 with a structured error from Zod, never a 500 or a thrown stack. Pinned in Tasks 6/7.
- **The thumbnail proxy pointed at a non-image or a failing host** → a clean 4xx/5xx, size-capped, never a hang or an unbounded buffer. Pinned in Task 10.

---

### Task 1: Engine seams — injectable job source + per-item hook

**Files:**
- Modify: `src/pipeline.mjs` (`BatchRunner` constructor deps; `run()` source construction; `_runJobs` per-item callback)
- Test: `test/pipeline.test.mjs`

**Why:** `run()` currently calls `createJobSource(this.config)` itself, so the merged `StoreJobSource` cannot drive a run; and nothing exposes per-item results for needs-review/live item events. Both additions are gated/defaulted so existing behavior is unchanged.

**Interfaces:**
- Consumes: existing `BatchRunner(config, logger, deps)`, `run()` (`src/pipeline.mjs:182-247`), `_runJobs` (`:251-334`), `createJobSource`.
- Produces:
  - `deps.createJobSource` — `run()` uses `this._createJobSource = deps.createJobSource || createJobSource` in place of the direct call. Absent → identical to today.
  - `deps.onItem(rec)` — called in `_runJobs` after each non-skipped item with the result record `rec` (`{...job, ...r, ok, saved?, total?, complete?, via?, error?}`), after the status write. Absent → not called.

- [ ] **Step 1: Write failing tests** in `test/pipeline.test.mjs`

```javascript
test("run() uses an injected createJobSource", async () => {
  // Force the empty-list early return (run() returns 1 before launching a browser
  // when config.listFile is set and the source loads zero jobs) so the test needs no Chromium.
  const fakeSource = { hasStatus: true, load: async () => [], setStatus() {}, setReason() {} };
  let used = false;
  const runner = new BatchRunner({ listFile: "x.csv" }, noopLogger,
    { createJobSource: () => { used = true; return fakeSource; } });
  const code = await runner.run();
  assert.equal(used, true);
  assert.equal(code, 1); // "no links found" path — no browser launched
});

test("_runJobs calls deps.onItem with each item's result record", async () => {
  const seen = [];
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger, { onItem: (rec) => seen.push(rec) });
  runner._scrapeJob = async (s, job) => ({ saved: 2, total: 2, complete: true });
  const source = { hasStatus: false };
  await runner._runJobs({ jobs: [{ url: "https://x/1", status: "" }], source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://x/1");
  assert.equal(seen[0].ok, true);
});

test("onItem absent and createJobSource absent → behavior unchanged", async () => { /* existing stop/skip tests still pass */ });
```

- [ ] **Step 2: Run to verify fail** — `node --test test/pipeline.test.mjs` → FAIL.
- [ ] **Step 3: Implement** — add `this._createJobSource = deps.createJobSource || createJobSource;` and `this._onItem = deps.onItem || null;` in the constructor; use `this._createJobSource(this.config, this.logger)` in `run()`; call `this._onItem?.(rec)` in `_runJobs` after the status write (`:331`).
- [ ] **Step 4: Run to verify pass** — `node --test test/pipeline.test.mjs` → PASS, then `node --test` (full suite) → PASS.
- [ ] **Step 5: Commit** — `feat(engine): injectable job source and per-item hook on BatchRunner`

---

### Task 2: Server scaffold, config, health & Drive-status routes

**Files:**
- Create: `dashboard/server/package.json`, `dashboard/server/src/app.mjs` (builds the Fastify instance), `dashboard/server/src/server.mjs` (listen entry), `dashboard/server/src/config.mjs` (port, data dir, paths), `dashboard/server/src/routes/system.mjs`
- Modify: `.gitignore` (ignore `dashboard/server/data/`)
- Test: `dashboard/server/test/system.test.mjs`

**Interfaces:**
- Produces:
  - `buildApp(deps = {}): FastifyInstance` — registers routes; `deps` injects the store, run manager, browser-session factory, `fetch`, and `driveStatus` fn so tests pass fakes. No `.listen()` here.
  - `GET /api/health` → `{ ok: true }`.
  - `GET /api/drive/status` → `{ connected, credentialsPath, tokenPath, hint }` where `connected` is `existsSync(credentials.json) && existsSync(token.json)` (paths from DEFAULTS `driveCredentials`/`driveToken`), `hint` names `node authorize.mjs` when not connected. The fs check is injected (`deps.driveStatus`) for tests.

- [ ] **Step 1: Write failing tests** in `dashboard/server/test/system.test.mjs` — `buildApp().inject({method:"GET",url:"/api/health"})` → 200 `{ok:true}`; `/api/drive/status` with injected `driveStatus` returning `{connected:false}` → 200 with a `hint` mentioning `authorize.mjs`.
- [ ] **Step 2: Run to verify fail** — `node --test dashboard/server/test/system.test.mjs` → FAIL.
- [ ] **Step 3: Implement** — `package.json` with deps (`fastify`, `@fastify/websocket`, `better-sqlite3`, `zod`) and a `test` script (`node --test`); `buildApp` wiring; the two routes. Install deps in `dashboard/server/`.
- [ ] **Step 4: Run to verify pass** — focused test → PASS.
- [ ] **Step 5: Commit** — `feat(server): scaffold Fastify app with health and Drive-status routes`

---

### Task 3: SQLite schema & migrations

**Files:**
- Create: `dashboard/server/src/db/db.mjs` (open connection), `dashboard/server/src/db/migrations.mjs` (ordered DDL runner)
- Test: `dashboard/server/test/db.test.mjs`

**Interfaces:**
- Produces: `openDb(path = ":memory:"): Database` (better-sqlite3, `WAL` for file DBs, `foreign_keys = ON`), `migrate(db): void` (idempotent; tracks applied migrations in a `_migrations` table).
- Schema:
  - `projects` (`id` PK, `name`, `recipe_json` TEXT, `created_at`, `updated_at`) — the recipe is stored as JSON (the engine-facing recipe shape).
  - `runs` (`id` PK, `project_id` FK, `label`, `state` TEXT in `queued|running|stopped|done|failed`, `created_at`, `started_at`, `finished_at`).
  - `run_items` (`id` PK, `run_id` FK, `url`, `name`, `status` TEXT (`''`/`retry`/`done`/`skip`), `reason` TEXT, `saved` INT, `total` INT, `needs_review` INT, `position` INT).

- [ ] **Step 1: Write failing tests** in `dashboard/server/test/db.test.mjs` — `migrate(openDb())` creates all tables (query `sqlite_master`); running `migrate` twice is a no-op; a `run_items` row with a bad `runs` FK is rejected (foreign_keys on).
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** — `openDb`, `migrate` with an array of `{ id, sql }` migrations.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(server): add SQLite schema and migration runner`

---

### Task 4: Store (synchronous) — StoreJobSource contract + CRUD

**Files:**
- Create: `dashboard/server/src/db/store.mjs`
- Test: `dashboard/server/test/store.test.mjs`

**Interfaces:**
- Consumes: `openDb`/`migrate` (Task 3); the `StoreJobSource` contract from the engine (`loadItems(runId)`, `setItemStatus(id,value)`, `setItemReason(id,text)` — all **synchronous**).
- Produces: `createStore(db): Store` with, at minimum:
  - Job-source contract: `loadItems(runId)` → `[{ id, url, name, status }]` ordered by `position`; `setItemStatus(id, value)`; `setItemReason(id, text)`.
  - Projects: `createProject({name, recipe})`, `listProjects()`, `getProject(id)`, `updateProject(id, patch)`, `deleteProject(id)` (recipe JSON-serialized/parsed at the boundary).
  - Runs/items: `createRun({projectId, label})`, `listRuns()`, `getRun(id)`, `setRunState(id, state, times?)`, `addItems(runId, urls)` (assigns `position`), `listItems(runId)`, `setItemResult(id, {saved,total,needsReview})`, `nextQueuedRun()`.

- [ ] **Step 1: Write failing tests** in `dashboard/server/test/store.test.mjs` (use `openDb()` in-memory) — create project→run→addItems; `loadItems` returns them in `position` order with `{id,url,name,status}`; `setItemStatus`/`setItemReason` persist and are synchronous (return before assertion, no await); `setItemResult` sets `needs_review`; `nextQueuedRun` returns the oldest `queued` run.
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** — prepared statements; JSON (de)serialization for recipe; synchronous throughout.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(server): add synchronous SQLite store with job-source contract`

---

### Task 5: Zod domain schemas

**Files:**
- Create: `dashboard/server/src/schemas.mjs`
- Test: `dashboard/server/test/schemas.test.mjs`

**Interfaces:**
- Consumes: the engine recipe shape (`src/recipes/recipe.mjs` header) and `ImageRules` fields (`src/recipes/image-filter.mjs`).
- Produces (Zod schemas + inferred types): `recipeSchema` (name, contentType `image|text`, optional `match.hosts[]`, `text` {mode `article|pattern|selector`, selector?, fields[], patterns[]}, `image` {pipeline[], rules{minWidth?,minHeight?,minBytes?,includeSelector?,excludeSelector?,includeUrl?,excludeUrl?,position?{from?,to?}}, expectCount?}, output {cbz?,pdf?,keepLoose?,quality?,format?,drive?,driveFolder?,driveSubfolder?}), `createProjectSchema`, `updateProjectSchema`, `createRunSchema` ({projectId, label?}), `enqueueSchema` ({urls: string[] (http(s))}), `previewSchema` ({url, recipe}). Export a `parseOr400(schema, data)` helper returning `{ok,data}|{ok:false,error}`.

- [ ] **Step 1: Write failing tests** — a valid image recipe parses; an unknown `contentType` or `text.mode` fails; `enqueueSchema` rejects a non-http url; `parseOr400` shapes the error.
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** the schemas + helper.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(server): add Zod domain schemas and parse helper`

---

### Task 6: Projects API (recipes CRUD)

**Files:**
- Create: `dashboard/server/src/routes/projects.mjs`
- Test: `dashboard/server/test/projects.test.mjs`

**Interfaces:**
- Consumes: the store (Task 4), schemas (Task 5), `buildApp` deps (Task 2).
- Produces routes (all JSON): `POST /api/projects` (body `createProjectSchema`, recipe validated by `recipeSchema`) → 201 `{project}`; `GET /api/projects` → `{projects}`; `GET /api/projects/:id` → `{project}`|404; `PUT /api/projects/:id` (`updateProjectSchema`) → `{project}`|404; `DELETE /api/projects/:id` → 204|404. Invalid body → 400 via `parseOr400`.

- [ ] **Step 1: Write failing tests** via `app.inject()` with an in-memory store injected — create→get→list→update→delete happy paths; a bad recipe → 400; unknown id → 404.
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** the route module; register it in `buildApp`.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(server): add projects (recipes) CRUD API`

---

### Task 7: Runs API (create, items, enqueue, import, results)

**Files:**
- Create: `dashboard/server/src/routes/runs.mjs`, `dashboard/server/src/import-sheet.mjs` (wrap the engine's `SheetSource` to read an uploaded file into URLs)
- Test: `dashboard/server/test/runs.test.mjs`, `dashboard/server/test/import-sheet.test.mjs`

**Interfaces:**
- Consumes: store (Task 4), schemas (Task 5), engine `SheetSource` (`src/sources.mjs`).
- Produces routes: `POST /api/runs` (`createRunSchema`; creates a `queued` run bound to a project) → 201 `{run}`; `GET /api/runs` → `{runs}`; `GET /api/runs/:id` → `{run, items}`|404; `POST /api/runs/:id/items` (`enqueueSchema`) → `{added}` (only into a `queued`/`stopped` run — spec §8.1 forbids live-append; a `running` run → 409); `POST /api/runs/import` (multipart or a path param) → URLs parsed via `SheetSource`; `GET /api/runs/:id/results` → text records (RecordWriter `.json`) or produced image outputs listing, per the run's recipe. `importSheet(filePath): string[]` is the tested unit behind the import route.

- [ ] **Step 1: Write failing tests** — create run bound to a project; enqueue into queued run adds items; enqueue into a `running` run → 409; `importSheet` reads a fixture `.csv` of URLs; results route returns the record file contents when present.
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** routes + `importSheet`; register in `buildApp`.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(server): add runs API with enqueue, import, and results`

---

### Task 8: Run manager (single active run, config build, start/stop, needs-review)

**Files:**
- Create: `dashboard/server/src/run-manager.mjs`, `dashboard/server/src/build-run-config.mjs`
- Test: `dashboard/server/test/run-manager.test.mjs`, `dashboard/server/test/build-run-config.test.mjs`

**Interfaces:**
- Consumes: engine `BatchRunner` + its new `deps.createJobSource`/`deps.onItem` (Task 1), `StoreJobSource`, `boundResolver`, `imageRulesFromRecipe`, `createEventLogger`, `needsReview`, `DEFAULTS`; the store (Task 4); a broadcast `emit` (Task 9).
- Produces:
  - `buildRunConfig(recipe): Config` — `{ ...DEFAULTS, ... }` derived from the recipe: image recipe → `cbz/pdf/keepLoose/quality/format/drive/driveFolder/driveSubfolder` from `recipe.output`, `imageRules` from `imageRulesFromRecipe(recipe)`; text recipe → `text:true`, `textMode`, `textSelect`/`textPatterns` from `recipe.text`. `url`/`listFile` stay `null` (the store source supplies jobs).
  - `createRunManager({ store, emit, runnerFactory = defaultRunnerFactory, now }): RunManager` with `start(runId)`, `stop(runId)`, `activeRunId()`. `start` refuses (queues) when a run is already active (one at a time); builds the config, a `StoreJobSource(store, runId, logger)`, `logger = createEventLogger(ev => emit(runId, ev))`, `resolveProfile = boundResolver(recipe)`, `onItem = rec => { store.setItemResult(rec.id, {saved, total, needsReview: needsReview(rec, recipe)}); emit(runId, {type:"item", ...}); }`; runs `BatchRunner(config, logger, deps).run()`; sets run state `running`→`done|failed`; `stop` calls `runner.stop()` and the run ends `stopped`. **On completion (any terminal state), the manager auto-starts `store.nextQueuedRun()` if one exists**, so the queue drains one run at a time. `runnerFactory` is injected so tests use a fake runner (no browser).

- [ ] **Step 1: Write failing tests** — `buildRunConfig` maps an image recipe (rules + cbz+drive) and a text recipe (mode+selects) correctly, leaving `url`/`listFile` null; `run-manager` with a fake runnerFactory: `start` sets state running then done and marks a zero-saved item `needs_review`; a second `start` while active does not run concurrently; when the active run finishes, a queued run is auto-started (`nextQueuedRun`); `stop` calls the fake runner's `stop()` and the run ends `stopped`.
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** both modules; default `runnerFactory` constructs the real `BatchRunner`.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(server): add run manager and recipe→config builder`

---

### Task 9: WebSocket live events

**Files:**
- Create: `dashboard/server/src/hub.mjs` (pure pub/sub), `dashboard/server/src/routes/ws.mjs` (@fastify/websocket adapter)
- Test: `dashboard/server/test/hub.test.mjs`
- Modify: `dashboard/server/src/app.mjs` (register `@fastify/websocket` + ws route; wire `hub.emit` as the run manager's `emit`)

**Interfaces:**
- Produces: `createHub(): { emit(runId, event), subscribe(runId, fn): unsubscribe, subscriberCount(runId) }` — a **synchronous** in-memory fan-out (satisfies the sync-`emit` constraint). The ws route (`GET /api/ws?runId=`) subscribes the socket and forwards events as JSON; unsubscribes on close.

- [ ] **Step 1: Write failing tests** in `dashboard/server/test/hub.test.mjs` — `subscribe` receives subsequent `emit`s for its runId only; `unsubscribe` stops delivery; `emit` with no subscribers is a no-op; `emit` is synchronous (a throwing subscriber is isolated, never rejects). (The pure hub is the unit under test; the thin ws adapter is exercised by the run-manager wiring.)
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** `createHub` and the ws route; register in `app.mjs`.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `feat(server): add WebSocket live-event hub and route`

---

### Task 10: Preview & thumbnail-proxy API

**Files:**
- Create: `dashboard/server/src/routes/preview.mjs`, `dashboard/server/src/browser-pool.mjs` (lazy single `BrowserSession`)
- Test: `dashboard/server/test/preview.test.mjs`

**Interfaces:**
- Consumes: engine `previewText`, `imagePreview`, `runtimeUnenforcedImageRuleKeys`, `BrowserSession`; schemas (Task 5).
- Produces routes:
  - `POST /api/preview/text` (`previewSchema`) → `previewText(...)` result (`{status, via, mode, fields}`); session from the browser pool, injected in tests.
  - `POST /api/preview/image` (`previewSchema`) → `imagePreview(...)` result (`{status, via, images}`) **plus** `unenforcedRuleKeys: runtimeUnenforcedImageRuleKeys(recipe.image?.rules)` so the UI can warn that selector/position rules won't apply at run (spec §7.4.5 honest boundary).
  - `GET /api/thumb?url=` → streams the image through the server (sets the target origin as `Referer` to defeat hotlinking), **capped** (e.g. reject non-`image/*` content-type and bodies over a max size), returning a clean 4xx/5xx on failure. `fetch` is injected for tests.
  - `getBrowser()` from `browser-pool.mjs` lazily launches one `BrowserSession` and reuses it; `closeBrowser()` for shutdown.

- [ ] **Step 1: Write failing tests** (inject fake `previewText`/`imagePreview`/`fetch`/session) — text preview returns normalized fields; image preview includes `unenforcedRuleKeys` for a recipe with `excludeSelector`; `/api/thumb` streams an injected image response, and rejects a non-image content-type with 4xx and an over-cap body without buffering it all.
- [ ] **Step 2: Run to verify fail** → FAIL.
- [ ] **Step 3: Implement** routes + browser pool; register in `app.mjs`.
- [ ] **Step 4: Run to verify pass** → PASS, then full backend suite `cd dashboard/server && node --test` → PASS.
- [ ] **Step 5: Commit** — `feat(server): add preview and thumbnail-proxy API`

---

## Done when

- `cd dashboard/server && node --test` passes; root `node --test` still green (Task 1's engine change caused no regression).
- The server can: create a project (recipe), create a run bound to it, enqueue/import URLs, start it (one at a time) driving `BatchRunner` via `StoreJobSource` + `boundResolver`, stream progress + per-item results over WS, mark needs-review, stop cleanly, preview a page (text + image) with inert-rule warnings, proxy thumbnails, and report Drive status — all without the CLI.
- Selector/position image rules are never presented as run-enforced; the preview response carries `unenforcedRuleKeys`.

## Notes for the frontend plan (plan 3)

- API base `/api/*`; WS at `/api/ws?runId=`. Event shapes: engine log/progress events (from `createEventLogger`, `ts` = epoch ms) plus `{type:"item", ...}` and run-state changes.
- Thumbnails load via `/api/thumb?url=` (not the raw image URL) to handle hotlink/auth.
- The builder must gate image-rule inputs by `unenforcedRuleKeys` (selector/position = preview-only).
