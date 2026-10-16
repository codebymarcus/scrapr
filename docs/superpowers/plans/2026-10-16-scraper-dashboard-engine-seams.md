# Scraper Dashboard — Engine Seams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the additive, independently-testable library seams to the existing scraper engine that a dashboard backend will drive — programmatic control, a store-backed job source, data-driven recipes (image-first), a structured-event logger, and no-write page previews.

**Architecture:** Pure additive modules alongside the current engine. New code depends on injected abstractions (a `store` object, an `emit` callback, a `page`/`session`) so every seam is unit-testable with fakes and **no** browser, database, or network. Existing scraping behavior is unchanged whenever the new features are unused.

**Tech Stack:** Node.js ESM (`"type":"module"`), no TypeScript, no build step. Tests via Node's built-in runner (`node --test`), one `test/<name>.test.mjs` per module. Existing deps only (`playwright`, `sharp`, `linkedom`, …) — **no new dependency is added in this plan** (SQLite stays in the backend plan).

**Spec:** `docs/superpowers/specs/2026-10-16-scraper-dashboard-design.md` (this plan implements §5.4 and the image-first parts of §7.4; §8.1 decisions apply).

## Global Constraints

- Node ESM only; **named exports** for all new functions/classes (match existing `src/` style; `export default` is reserved for profile data files).
- 2-space indent, double quotes, trailing commas (match surrounding files).
- **No new npm dependency** in this plan. No SQLite, no server, no WebSocket here.
- **Behavior-preserving:** when a run has no recipe image rules / no event logger / no store source, the engine must behave exactly as it does today. Every behavior-changing task includes a test proving the no-feature path is unchanged.
- New modules take their side-effecting collaborators (`store`, `emit`, `session`, `page`, `fetchFn`) as injected params/deps with sane defaults, mirroring `acquireAndExtract(..., { deps })` and `BatchRunner(config, logger, deps)`.
- Tests use `import { test } from "node:test"; import assert from "node:assert/strict";` and run with `node --test test/<file>.test.mjs`.
- The engine-facing **recipe shape** is a plain object defined in Task 3; the backend plan maps DB rows to it.

## Review Focus

- **Empty/absent image rules** → a run must capture exactly as today (no filtering, no post-pass). Pinned in Task 8.
- **A page with zero candidate images** → `collectCandidateImages` returns `[]` (UI shows "none found"), never throws. Pinned in Task 6.
- **Rules that match nothing** → `filterImages` returns `[]` and the item is classified **needs-review**, not silent success. Pinned in Task 7 + Task 9.
- **An `emit` callback that throws** → the event logger swallows it so a scrape is never broken by the live layer. Pinned in Task 4.
- **A store that throws on write** (e.g. DB busy) → `StoreJobSource.setStatus/​setReason` warn and continue, never crash the batch (mirror `SheetSource._save`). Pinned in Task 2.

---

### Task 1: Programmatic stop on BatchRunner

**Files:**
- Modify: `src/pipeline.mjs` (class `BatchRunner`, near the `_stopping` field at line 171 and the SIGINT handler at 225–233)
- Test: `test/pipeline.test.mjs` (add to existing file)

**Interfaces:**
- Consumes: existing `BatchRunner(config, logger, deps)`, `_runJobs(...)`, `_stopping`.
- Produces: `BatchRunner.prototype.stop(): void` — public, idempotent; sets `_stopping = true` so the loop finishes the current job then stops. `BatchRunner.prototype.isStopping(): boolean`.

- [ ] **Step 1: Write the failing test** in `test/pipeline.test.mjs`

```javascript
test("stop(): public method stops the loop after the current job", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const ran = [];
  runner._scrapeJob = async (session, job) => {
    ran.push(job.url);
    if (job.url === "https://x/1") runner.stop(); // public API, not _stopping
    return { saved: 1, total: 1, complete: true };
  };
  const source = { hasStatus: false };
  const jobs = [{ url: "https://x/1", status: "", row: 1 }, { url: "https://x/2", status: "", row: 2 }];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(ran, ["https://x/1"]);
  assert.equal(runner.isStopping(), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL (`runner.stop is not a function`).

- [ ] **Step 3: Implement `stop()` and `isStopping()` on `BatchRunner`** in `src/pipeline.mjs`

`stop()` sets `this._stopping = true`. `isStopping()` returns `this._stopping`. The SIGINT handler can call `this.stop()` instead of assigning directly (optional tidy; keep the "second Ctrl-C forces exit" behavior).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS (all existing pipeline tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/pipeline.mjs test/pipeline.test.mjs
git commit -m "feat(engine): add public BatchRunner.stop()/isStopping()"
```

---

### Task 2: Store-backed JobSource

**Files:**
- Modify: `src/sources.mjs` (add class; export)
- Test: `test/sources.test.mjs` (add to existing file)

**Interfaces:**
- Consumes: the JobSource interface the runner relies on — `load()`, `hasStatus`, `setStatus(job, value)`, `setReason(job, text)` (see `src/sources.mjs` header and `_runJobs` usage in `src/pipeline.mjs:264-331`).
- Produces: `class StoreJobSource { constructor(store, runId, logger) }` where `store` is an injected object with `async loadItems(runId): Array<{ id, url, name, status }>`, `setItemStatus(id, value)`, `setItemReason(id, text)`. `load()` returns jobs shaped `{ url, name, status, id }` (note: `id`, not `row`). `hasStatus` is always `true`. `setStatus(job, value)` → `store.setItemStatus(job.id, value)` wrapped in try/catch (warn via logger, never throw). `setReason` likewise.

- [ ] **Step 1: Write the failing tests** in `test/sources.test.mjs`

```javascript
test("StoreJobSource.load maps store items to jobs with id", async () => {
  const store = { async loadItems() { return [{ id: 7, url: "https://x/1", name: "One", status: "" }]; },
                  setItemStatus() {}, setItemReason() {} };
  const s = new StoreJobSource(store, "run1", noopLogger);
  const jobs = await s.load();
  assert.equal(s.hasStatus, true);
  assert.deepEqual(jobs, [{ url: "https://x/1", name: "One", status: "", id: 7 }]);
});

test("StoreJobSource.setStatus/setReason forward by id and survive a throwing store", () => {
  const calls = [];
  const store = { loadItems() {}, setItemStatus: (id, v) => calls.push(["s", id, v]),
                  setItemReason: () => { throw new Error("db busy"); } };
  const s = new StoreJobSource(store, "run1", noopLogger);
  s.setStatus({ id: 7 }, "done");
  assert.doesNotThrow(() => s.setReason({ id: 7 }, "x")); // swallowed + warned
  assert.deepEqual(calls, [["s", 7, "done"]]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/sources.test.mjs`
Expected: FAIL (`StoreJobSource is not defined`); add the import from `../src/sources.mjs`.

- [ ] **Step 3: Implement `StoreJobSource`** in `src/sources.mjs` (export it). Writes go through try/catch that calls `this.logger?.warn(...)` on failure, mirroring `SheetSource._save`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/sources.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources.mjs test/sources.test.mjs
git commit -m "feat(engine): add StoreJobSource (store-abstraction job source)"
```

---

### Task 3: Engine-facing recipe model & bound resolver

**Files:**
- Create: `src/recipes/recipe.mjs`
- Test: `test/recipe.test.mjs`

**Interfaces:**
- Consumes: the profile shape the engine expects (`src/profiles/profile.mjs` header: `{ name, match, contentType, text?, pipeline, metadata }`) and `resolveProfile`/`resolvePipeline` usage in `src/pipeline.mjs:293-306`.
- Produces:
  - Recipe shape (documented in the module): `{ name, contentType: "image"|"text", match?: {hosts?: string[]}, text?: {mode, selector?, fields?, patterns?}, image?: {rules?: ImageRules, pipeline?: Array<{mechanism, maxAttempts?, params?}>}, metadata?: object }`.
  - `recipeToProfile(recipe): Profile` — returns a profile object; `match` built via `hostMatch(...recipe.match.hosts)` when hosts given, else a matcher returning `true`; `pipeline` from `recipe.image.pipeline` (image) or `[]` (text); `text` passed through; `metadata` passed through or `{}`.
  - `imageRulesFromRecipe(recipe): ImageRules | null` — returns `recipe.image?.rules ?? null`.
  - `boundResolver(recipe): (url) => Profile` — ignores the URL, always returns `recipeToProfile(recipe)` (the per-run binding from §8.1); injected into `BatchRunner` as `deps.resolveProfile`.

- [ ] **Step 1: Write the failing tests** in `test/recipe.test.mjs`

```javascript
test("recipeToProfile maps an image recipe to a profile shape", () => {
  const p = recipeToProfile({ name: "comic", contentType: "image",
    match: { hosts: ["batcave.biz"] },
    image: { pipeline: [{ mechanism: "chapter-aware" }], rules: { minWidth: 500 } } });
  assert.equal(p.name, "comic");
  assert.equal(p.contentType, "image");
  assert.equal(p.match("https://batcave.biz/x"), true);
  assert.equal(p.match("https://other.com/x"), false);
  assert.deepEqual(p.pipeline, [{ mechanism: "chapter-aware" }]);
});

test("recipeToProfile defaults match to always-true when no hosts", () => {
  const p = recipeToProfile({ name: "any", contentType: "text", text: { mode: "selector" } });
  assert.equal(p.match("https://anything/x"), true);
  assert.deepEqual(p.metadata, {});
});

test("boundResolver ignores url and returns the recipe's profile", () => {
  const r = { name: "x", contentType: "image", image: { pipeline: [] } };
  const resolve = boundResolver(r);
  assert.equal(resolve("https://a").name, "x");
  assert.equal(resolve("https://b").name, "x");
});

test("imageRulesFromRecipe returns rules or null", () => {
  assert.deepEqual(imageRulesFromRecipe({ image: { rules: { minWidth: 10 } } }), { minWidth: 10 });
  assert.equal(imageRulesFromRecipe({ contentType: "text" }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/recipe.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/recipes/recipe.mjs`** — `recipeToProfile`, `imageRulesFromRecipe`, `boundResolver`. Reuse `hostMatch` from `../profiles/profile.mjs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/recipe.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recipes/recipe.mjs test/recipe.test.mjs
git commit -m "feat(engine): add data-driven recipe model and bound resolver"
```

---

### Task 4: Structured-event logger

**Files:**
- Create: `src/events/event-logger.mjs`
- Test: `test/event-logger.test.mjs`

**Interfaces:**
- Consumes: the logger method shape produced by `createLogger` (`src/logger.mjs:53-90`): `info, success, warn, muted, step, section, error, verbose, debug, progressBar, endProgress, close`.
- Produces: `createEventLogger(emit, base = null): Logger` — returns an object with every method above. Each call invokes `emit(event)` then, if `base` is given, forwards to `base[method](...)`. Event shapes: text methods → `{ type: "log", level: <method>, message: string, ts }`; `progressBar(current, total, label)` → `{ type: "progress", current, total, label, ts }`; `endProgress()` → `{ type: "progress-end", ts }`. `emit` is wrapped so a throw is swallowed (logged to `base?.debug` if present). `close()` awaits `base?.close?.()`.

- [ ] **Step 1: Write the failing tests** in `test/event-logger.test.mjs`

```javascript
test("createEventLogger emits structured events and tees to base", () => {
  const events = []; const based = [];
  const base = { info: (m) => based.push(m), progressBar() {}, debug() {} };
  const log = createEventLogger((e) => events.push(e), base);
  log.info("hello");
  log.progressBar(3, 10, "pages");
  assert.equal(events[0].type, "log");
  assert.equal(events[0].level, "info");
  assert.equal(events[0].message, "hello");
  assert.deepEqual([events[1].type, events[1].current, events[1].total], ["progress", 3, 10]);
  assert.deepEqual(based, ["hello"]);
});

test("createEventLogger swallows a throwing emit so scraping is never broken", () => {
  const log = createEventLogger(() => { throw new Error("ws down"); }, null);
  assert.doesNotThrow(() => log.error("boom"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/event-logger.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/events/event-logger.mjs`** (`createEventLogger`). Build the method set from a list to stay DRY; `progressBar`/`endProgress`/`close` are special-cased.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/event-logger.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events/event-logger.mjs test/event-logger.test.mjs
git commit -m "feat(engine): add structured-event logger adapter"
```

---

### Task 5: No-write text/field preview

**Files:**
- Create: `src/preview/text-preview.mjs`
- Test: `test/text-preview.test.mjs`

**Interfaces:**
- Consumes: `acquireAndExtract({ url, mode, opts, session, config, logger, deps })` (`src/text/acquire.mjs:13`) which already never writes; `buildOpts`, `resolveMode` (`src/text/scrape-text.mjs:17-39`).
- Produces: `async previewText({ url, recipe, session, config, logger, deps = {} }): PreviewResult`. Resolves mode/opts from the recipe (via `recipeToProfile` + `resolveMode`/`buildOpts`), calls `acquireAndExtract` (injectable via `deps.acquireAndExtract`), and returns `{ status, via, mode, fields }` where `fields` is a normalized `[{ name, value }]` for selector/pattern, or `{ title, byline, excerpt, markdown }` for article. **Writes nothing.** On acquire failure returns `{ status: "fail", code }`.

- [ ] **Step 1: Write the failing tests** in `test/text-preview.test.mjs`

```javascript
test("previewText returns normalized selector fields without writing", async () => {
  const fakeAcquire = async () => ({ status: "ok", via: "http", bytes: 1, requests: 1,
    payload: { kind: "selector", empty: false, fields: { title: "Hi", body: "Words" } } });
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "selector",
    fields: [{ name: "title", selector: "h1" }, { name: "body", selector: "article" }] } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: fakeAcquire } });
  assert.equal(res.status, "ok");
  assert.equal(res.mode, "selector");
  assert.deepEqual(res.fields, [{ name: "title", value: "Hi" }, { name: "body", value: "Words" }]);
});

test("previewText surfaces acquire failure", async () => {
  const fakeAcquire = async () => ({ status: "fail", code: "HTTP_ERROR" });
  const res = await previewText({ url: "https://x", recipe: { contentType: "text", text: { mode: "article" } },
    session: {}, config: {}, logger: noopLogger, deps: { acquireAndExtract: fakeAcquire } });
  assert.equal(res.status, "fail");
  assert.equal(res.code, "HTTP_ERROR");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/text-preview.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/preview/text-preview.mjs`** (`previewText`). Reuse `recipeToProfile` (Task 3), `resolveMode`, `buildOpts`. Normalize the payload per `kind` (`selector`→fields map, `pattern`→matches grouped by type, `article`→doc fields).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/text-preview.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preview/text-preview.mjs test/text-preview.test.mjs
git commit -m "feat(engine): add no-write text/field preview"
```

---

### Task 6: Candidate-image collection & image preview

**Files:**
- Create: `src/preview/image-preview.mjs`
- Test: `test/image-preview.test.mjs`

**Interfaces:**
- Consumes: a Playwright `page` (its `evaluate` only, for testability) and `session.newPage()` + `openReader(page, url, config, logger)` (`src/navigation.mjs`, as used in `src/text/acquire.mjs:56-60`).
- Produces:
  - `async collectCandidateImages(page, deps = {}): Array<Candidate>` where `Candidate = { url, width, height, selector, index }`. Implemented by a single `page.evaluate(...)` that walks `document.images`, reading `currentSrc||src`, `naturalWidth/Height`, a CSS selector path, and DOM index. Returns `[]` when there are no images. (The browser-side function is a plain string/function passed to `evaluate`; keep it small.)
  - `async imagePreview({ url, session, config, logger, deps = {} }): { status, via, images }`. Opens a page via `session.newPage()`, runs `openReader` (injectable via `deps.openReader`), calls `collectCandidateImages`, closes the page in `finally`. On navigation failure returns `{ status: "fail", code, images: [] }`. **Downloads/packages nothing.** (Thumbnail bytes are fetched by the backend's proxy, not here.)

- [ ] **Step 1: Write the failing tests** in `test/image-preview.test.mjs`

```javascript
test("collectCandidateImages returns descriptors from the page", async () => {
  const page = { async evaluate() { return [
    { url: "https://x/1.jpg", width: 1200, height: 800, selector: "div.reader > img:nth-child(1)", index: 0 },
    { url: "https://x/logo.png", width: 88, height: 31, selector: "header img", index: 1 }
  ]; } };
  const out = await collectCandidateImages(page);
  assert.equal(out.length, 2);
  assert.equal(out[0].width, 1200);
});

test("collectCandidateImages returns [] on a page with no images", async () => {
  const page = { async evaluate() { return []; } };
  assert.deepEqual(await collectCandidateImages(page), []);
});

test("imagePreview opens, collects, and closes the page; failure is non-throwing", async () => {
  let closed = false;
  const page = { async evaluate() { return [{ url: "https://x/1.jpg", width: 10, height: 10, selector: "img", index: 0 }]; },
                 async close() { closed = true; } };
  const session = { async newPage() { return page; } };
  const res = await imagePreview({ url: "https://x", session, config: {}, logger: noopLogger,
    deps: { openReader: async () => ({ status: () => 200 }) } });
  assert.equal(res.status, "ok");
  assert.equal(res.images.length, 1);
  assert.equal(closed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/image-preview.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/preview/image-preview.mjs`** (`collectCandidateImages`, `imagePreview`). Mirror `acquireAndExtract`'s escalation/`finally`-close shape; classify a null/≥400 `openReader` response as a fail like `acquire.mjs:68-72`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/image-preview.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preview/image-preview.mjs test/image-preview.test.mjs
git commit -m "feat(engine): add no-write image preview (candidate collection)"
```

---

### Task 7: Image filter rules (pure)

**Files:**
- Create: `src/recipes/image-filter.mjs`
- Test: `test/image-filter.test.mjs`

**Interfaces:**
- Consumes: `Candidate` from Task 6 (`{ url, width, height, selector, index, bytes? }`) and `ImageRules` from Task 3.
- Produces: `filterImages(candidates, rules): Candidate[]`. `ImageRules` fields (all optional, ANDed): `minWidth`, `minHeight`, `minBytes`, `includeSelector` (substring match on `selector`), `excludeSelector` (substring), `includeUrl` (substring on `url`), `excludeUrl`, `position` (`{ from?, to? }` inclusive index range). `null`/empty rules → return `candidates` unchanged (Review Focus). Missing numeric fields on a candidate are treated as not-failing that numeric rule only when the field is absent-and-unknown? No — a candidate missing `width` fails a `minWidth` rule (we cannot confirm it passes). Document this choice in the module.

- [ ] **Step 1: Write the failing tests** in `test/image-filter.test.mjs`

```javascript
const C = [
  { url: "https://x/hero.jpg", width: 1200, height: 800, selector: "div.reader img", index: 0 },
  { url: "https://x/logo.png", width: 88, height: 31, selector: "header img", index: 1 },
  { url: "https://x/ad.gif", width: 300, height: 250, selector: ".ad img", index: 2 },
];

test("filterImages: null/empty rules pass everything through", () => {
  assert.equal(filterImages(C, null).length, 3);
  assert.equal(filterImages(C, {}).length, 3);
});

test("filterImages: minWidth + excludeSelector keeps the hero only", () => {
  const out = filterImages(C, { minWidth: 500, excludeSelector: ".ad" });
  assert.deepEqual(out.map((c) => c.url), ["https://x/hero.jpg"]);
});

test("filterImages: rules that match nothing return []", () => {
  assert.deepEqual(filterImages(C, { minWidth: 5000 }), []);
});

test("filterImages: position range selects by index", () => {
  assert.deepEqual(filterImages(C, { position: { from: 1, to: 2 } }).map((c) => c.index), [1, 2]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/image-filter.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/recipes/image-filter.mjs`** (`filterImages`). Pure; no I/O.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/image-filter.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recipes/image-filter.mjs test/image-filter.test.mjs
git commit -m "feat(engine): add pure image filter rules"
```

---

### Task 8: Apply image rules during a run (behavior-gated)

**Files:**
- Modify: `src/capture.mjs` (URL/selector/minBytes-evaluable gate in `_onResponse`)
- Modify: `src/pipeline.mjs` (`scrapeJob`: post-capture dimension filter before packaging, lines ~119-132)
- Test: `test/capture.test.mjs` (add), `test/pipeline.test.mjs` (add)

**Interfaces:**
- Consumes: `config.imageRules` (an `ImageRules` object, absent today), `filterImages` (Task 7), `ImageCapture.list()` (`src/capture.mjs:91`), and sharp (already used by `src/processor.mjs`) to read captured pixel dimensions.
- Produces: no new export; a gated behavior — when `config.imageRules` is set, URL-evaluable rules (`includeUrl`/`excludeUrl`/`minBytes`) are applied in capture, and dimension rules (`minWidth`/`minHeight`) are applied as a **post-capture pass** in `scrapeJob` (drop buffers whose decoded dimensions fail the rules) before `processor.process(...)`. When `config.imageRules` is absent, **no code path changes**.

- [ ] **Step 1: Write the failing tests**

In `test/capture.test.mjs` — a response whose URL matches `excludeUrl` is dropped only when `imageRules` is set (and with no rules, current behavior holds). Follow the existing fake-`resp` pattern in that file.

```javascript
test("capture: excludeUrl rule drops a matching image when imageRules set", async () => {
  // build config WITH imageRules:{excludeUrl:"/ad/"} and assert an /ad/ image is not captured,
  // then build config WITHOUT imageRules and assert the same image IS captured (behavior-preserving).
});
```

In `test/pipeline.test.mjs` — a unit test for the post-capture dimension filter helper (extract it as an exported pure helper `applyImageDimensionRules(images, rules, deps)` taking an injected `dimsOf(buffer) -> {width,height}` so it needs no sharp in the test):

```javascript
test("applyImageDimensionRules drops undersized images only when rules set", async () => {
  const imgs = [{ url: "a", buffer: Buffer.from("A") }, { url: "b", buffer: Buffer.from("B") }];
  const dimsOf = (buf) => (buf.toString() === "A" ? { width: 1200, height: 800 } : { width: 50, height: 50 });
  const kept = await applyImageDimensionRules(imgs, { minWidth: 500 }, { dimsOf });
  assert.deepEqual(kept.map((i) => i.url), ["a"]);
  const all = await applyImageDimensionRules(imgs, null, { dimsOf });
  assert.equal(all.length, 2); // no rules → unchanged
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/capture.test.mjs test/pipeline.test.mjs`
Expected: FAIL (rule gate / `applyImageDimensionRules` absent).

- [ ] **Step 3: Implement the gated behavior.** In `src/capture.mjs` `_onResponse`, after the existing checks, when `this.config.imageRules` is set apply the URL/bytes-evaluable subset. In `src/pipeline.mjs` add exported `applyImageDimensionRules(images, rules, { dimsOf })` (default `dimsOf` uses sharp metadata) and call it in `scrapeJob` on `capture.list()` before `processor.process(...)`, only when `config.imageRules` is set. Keep the no-rules path byte-for-byte unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/capture.test.mjs test/pipeline.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the full suite** (behavior-preservation check)

Run: `node --test`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/capture.mjs src/pipeline.mjs test/capture.test.mjs test/pipeline.test.mjs
git commit -m "feat(engine): apply recipe image rules during a run (gated)"
```

---

### Task 9: Needs-review classification (pure)

**Files:**
- Create: `src/recipes/review.mjs`
- Test: `test/review.test.mjs`

**Interfaces:**
- Consumes: the batch result shape (`{ complete, saved, total, contentType }` from `scrapeJob`/`scrapeText`) and the recipe (Task 3).
- Produces: `needsReview(result, recipe): boolean` — true when a run "succeeded" but the output is suspicious: `complete === true` **and** `saved === 0` (a required field/image rule captured nothing), or (image) `recipe.image?.expectCount` is set and `result.total !== expectCount`. The backend uses this to mark an item for review (§8.1). Pure.

- [ ] **Step 1: Write the failing tests** in `test/review.test.mjs`

```javascript
test("needsReview: complete but zero saved is flagged", () => {
  assert.equal(needsReview({ complete: true, saved: 0 }, { contentType: "text" }), true);
  assert.equal(needsReview({ complete: true, saved: 3 }, { contentType: "text" }), false);
});

test("needsReview: image count mismatch when expectCount set", () => {
  assert.equal(needsReview({ complete: true, saved: 10, total: 10 }, { image: { expectCount: 12 } }), true);
  assert.equal(needsReview({ complete: true, saved: 12, total: 12 }, { image: { expectCount: 12 } }), false);
});

test("needsReview: a failed job is not 'needs review' (it's a retry)", () => {
  assert.equal(needsReview({ complete: false, saved: 0 }, { contentType: "image" }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/review.test.mjs`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/recipes/review.mjs`** (`needsReview`). Pure; no I/O.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/review.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/recipes/review.mjs test/review.test.mjs
git commit -m "feat(engine): add needs-review classification helper"
```

---

## Done when

- `node --test` passes with all new tests and no regressions.
- The engine exposes, for the backend plan: `BatchRunner.stop()/isStopping()`, `StoreJobSource`, `recipeToProfile`/`imageRulesFromRecipe`/`boundResolver`, `createEventLogger`, `previewText`, `imagePreview`/`collectCandidateImages`, `filterImages`, `applyImageDimensionRules`, `needsReview`.
- With no recipe rules, no event logger, and the spreadsheet/URL sources, the CLI behaves exactly as before (full suite green proves it).
