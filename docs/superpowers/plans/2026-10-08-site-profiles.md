# Site Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve each job's scraping pipeline from its URL via a per-site *profile* (an ordered list of named, parameterized mechanisms) feeding the existing orchestrator, so adding a site is declarative and batcave becomes "just a profile."

**Architecture:** Profiles are JS modules (mostly data) that `match(url)` and declare a `pipeline` of mechanisms. The two existing strategies become parameterized mechanisms (`current` = keyboard-advance, `chapter-aware` = hash-addressing). A profile registry resolves URL → profile (generic catch-all) and builds the orchestrator's `[{strategy, maxAttempts}]` list per job; `config.strategies`, if set, overrides it globally. Orchestrator, validator, and capture are reused unchanged. Content type is threaded for a future text path; images only are built.

**Tech Stack:** Node.js ESM (`.mjs`), Playwright, `node --test` + `node:assert/strict`, dependency injection via constructor/params.

**Spec:** [docs/superpowers/specs/2026-10-08-site-profiles-design.md](../specs/2026-10-08-site-profiles-design.md)

## Global Constraints

- ES modules only (`.mjs`), no new runtime dependencies.
- Profiles live under `src/profiles/`; mechanisms stay under `src/strategies/`. One responsibility per file.
- Tests use `node:test` + `node:assert/strict`, one file per module under `test/`, fakes injected (no real browser) — mirror existing tests.
- Mechanism names are the existing strategy names verbatim: `current` and `chapter-aware`. `contentType` values: only `"image"` this phase.
- Behaviour change (intended, from spec §7): batcave → `[chapter-aware]`; every other site → `[current]`. `config.strategies`, when a non-empty array, overrides the profile pipeline globally and keeps its existing shape (`{ name, maxAttempts?, enabled? }`).
- Content-agnostic seams only; **no** text/HTML→Markdown, metadata extraction, auto-naming, concurrency, or scheduling in this phase.
- Commit after each task; message ends with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Review Focus

- **Malformed or unmatched URL** → `resolveProfile` must return the generic profile, never throw (pinned in Task 3).
- **`config.strategies` set after profiles land** → still overrides the pipeline globally, unchanged behaviour (pinned in Task 3).
- **Unknown mechanism name** in a profile pipeline or a config override → warned and skipped, no crash (pinned in Task 3).
- **Empty resolved pipeline for a job** (all entries disabled/unknown) → that row is marked `retry` and the batch continues, not aborts (pinned in Task 4).
- **Routing correctness** → a batcave URL resolves to `[chapter-aware]` and a generic URL to `[current]` (pinned in Tasks 3 and 4).

---

## Task 1: Parameterize the two mechanisms (strategies gain `params`)

**Files:**
- Modify: `src/strategies/browser-keyboard.mjs`
- Modify: `src/strategies/chapter-aware.mjs`
- Test: `test/browser-keyboard.test.mjs` (append), `test/chapter-aware.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `new BrowserKeyboardStrategy({ openReader?, ReaderDriver?, params? })` — stores `this.params` (default `{}`); `execute` runs with `cfg = { ...config, ...this.params }`.
  - `new ChapterAwareStrategy({ openReader?, params? })` — same `params` merge.

- [ ] **Step 1: Write the failing tests**

Append to `test/browser-keyboard.test.mjs`:
```js
test("current: profile params override config at execute time", async () => {
  let seenCfg;
  const strat = new BrowserKeyboardStrategy({
    params: { advanceKey: "ArrowDown", countSelector: ".x" },
    openReader: async () => {},
    ReaderDriver: class { constructor(_p, _c, cfg) { seenCfg = cfg; } async run() { return { total: 1 }; } }
  });
  const capture = { attach: async () => {}, size: 1, list: () => [] };
  const page = { async close() {} };
  await strat.execute({
    session: { newPage: async () => page }, job: { url: "u" },
    config: { advanceKey: "ArrowRight", settle: 700 }, capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(seenCfg.advanceKey, "ArrowDown", "param overrides config");
  assert.equal(seenCfg.countSelector, ".x");
  assert.equal(seenCfg.settle, 700, "non-overridden config is preserved");
});
```

Append to `test/chapter-aware.test.mjs`:
```js
test("chapter-aware: profile params override config at execute time", async () => {
  let seenCfg;
  const strat = new ChapterAwareStrategy({ params: { settle: 50 }, openReader: async (_p, _u, cfg) => { seenCfg = cfg; } });
  strat.detectTotal = async () => 0; // short-circuit the page loop
  const capture = fakeCapture();
  await strat.execute({
    session: { newPage: async () => fakePage() }, job: { url: "u" },
    config: { settle: 3000, jitter: 0 }, capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(seenCfg.settle, 50, "param overrides config");
});
```
(`fakeCapture`/`fakePage`/`noopLogger` already exist in `test/chapter-aware.test.mjs`; `noopLogger` already exists in `test/browser-keyboard.test.mjs`.)

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/browser-keyboard.test.mjs test/chapter-aware.test.mjs`
Expected: the two new tests FAIL (`seenCfg.advanceKey` is `"ArrowRight"` / `seenCfg.settle` is `3000` — params not yet applied).

- [ ] **Step 3: Add `params` to `browser-keyboard.mjs`**

```js
export class BrowserKeyboardStrategy {
  constructor({ openReader = defaultOpenReader, ReaderDriver = DefaultReaderDriver, params = {} } = {}) {
    this.name = "current";
    this.defaultMaxAttempts = 2;
    this._openReader = openReader;
    this._ReaderDriver = ReaderDriver;
    this.params = params;
  }

  async execute({ session, job, config, capture, meter, logger }) {
    const page = await session.newPage();
    const cfg = { ...config, ...this.params };
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, cfg, logger);
      const { total } = await new this._ReaderDriver(page, capture, cfg, logger).run();
      return ok({ downloaded: capture.size, total });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Add `params` to `chapter-aware.mjs`**

In the constructor, accept and store `params`:
```js
  constructor({ openReader = defaultOpenReader, params = {} } = {}) {
    this.name = "chapter-aware";
    this.defaultMaxAttempts = 1;
    this._openReader = openReader;
    this.params = params;
  }
```
In `execute`, build `cfg` and use it for `openReader` and `_collect`:
```js
  async execute({ session, job, config, capture, meter, logger }) {
    const page = await session.newPage();
    const cfg = { ...config, ...this.params };
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, cfg, logger);
      const total = await this._collect(page, capture, cfg, logger);
      const downloaded = capture.size;
      if (!(downloaded > 0)) return failed(FailureCode.EMPTY_RESULT, "no pages captured");
      return ok({ downloaded, total });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }
```
(`_collect` and `detectTotal` already take a `config` argument — they now receive `cfg`; no change to their bodies.)

- [ ] **Step 5: Run to verify they pass**

Run: `node --test test/browser-keyboard.test.mjs test/chapter-aware.test.mjs`
Expected: PASS (all, including the two new).

- [ ] **Step 6: Commit**

```bash
git add src/strategies/browser-keyboard.mjs src/strategies/chapter-aware.mjs test/browser-keyboard.test.mjs test/chapter-aware.test.mjs
git commit -m "feat(strategies): mechanisms accept per-site params merged over config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Profile module, helpers, and the two built-in profiles

**Files:**
- Create: `src/profiles/profile.mjs`, `src/profiles/batcave.mjs`, `src/profiles/generic.mjs`
- Test: `test/profiles.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ContentType = { IMAGE: "image" }`
  - `hostMatch(...hosts) → (url: string) => boolean`
  - `batcave` default export: `{ name:"batcave", match, contentType:"image", pipeline:[{mechanism:"chapter-aware", maxAttempts:1, params:{}}], metadata:{...} }`
  - `generic` default export: `{ name:"generic", match:()=>true, contentType:"image", pipeline:[{mechanism:"current", maxAttempts:2, params:{}}], metadata:{} }`

- [ ] **Step 1: Write the failing test**

```js
// test/profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContentType, hostMatch } from "../src/profiles/profile.mjs";
import batcave from "../src/profiles/batcave.mjs";
import generic from "../src/profiles/generic.mjs";

test("hostMatch: exact host and subdomain, not others, safe on bad URL", () => {
  const m = hostMatch("batcave.biz");
  assert.equal(m("https://batcave.biz/event/x/1"), true);
  assert.equal(m("https://www.batcave.biz/x"), true);
  assert.equal(m("https://notbatcave.biz/x"), false);
  assert.equal(m("https://example.com/x"), false);
  assert.equal(m("not a url"), false);
});

test("batcave profile: matches batcave, image content, chapter-aware pipeline", () => {
  assert.equal(batcave.match("https://batcave.biz/event/ultimate-marvel/395"), true);
  assert.equal(batcave.match("https://example.com/x"), false);
  assert.equal(batcave.contentType, ContentType.IMAGE);
  assert.deepEqual(batcave.pipeline.map((p) => p.mechanism), ["chapter-aware"]);
  assert.equal(batcave.pipeline[0].maxAttempts, 1);
});

test("generic profile: matches everything, image content, current pipeline", () => {
  assert.equal(generic.match("https://anything.example/x"), true);
  assert.equal(generic.contentType, ContentType.IMAGE);
  assert.deepEqual(generic.pipeline.map((p) => p.mechanism), ["current"]);
  assert.equal(generic.pipeline[0].maxAttempts, 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/profiles.test.mjs`
Expected: FAIL — cannot find module `../src/profiles/profile.mjs`.

- [ ] **Step 3: Create `src/profiles/profile.mjs`**

```js
// Site profile shape and helpers. A profile is per-site DATA (optionally with
// function hooks) that maps a URL to an ordered pipeline of named mechanisms.
//
// Profile = {
//   name: string,
//   match: (url: string) => boolean,
//   contentType: "image",                 // "text" is a future content type
//   pipeline: Array<{ mechanism: string, maxAttempts?: number, params?: object }>,
//   metadata: object                      // reserved seam (sub-project #2); may be {}
// }
export const ContentType = Object.freeze({ IMAGE: "image" });

// Build a matcher for one or more hosts: true when the URL's hostname equals a
// host or is a subdomain of it. Safe on malformed URLs (returns false).
export function hostMatch(...hosts) {
  const set = hosts.map((h) => String(h).toLowerCase());
  return (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return set.some((h) => host === h || host.endsWith(`.${h}`));
    } catch {
      return false;
    }
  };
}
```

- [ ] **Step 4: Create `src/profiles/batcave.mjs`**

```js
// batcave.biz "event" reader: a continuous/looping multi-chapter reader whose
// pages are addressed by #page-N fragment. Uses only the chapter-aware
// (hash-addressing) mechanism — keyboard-advance always fails here.
import { hostMatch, ContentType } from "./profile.mjs";

export default {
  name: "batcave",
  match: hostMatch("batcave.biz"),
  contentType: ContentType.IMAGE,
  pipeline: [{ mechanism: "chapter-aware", maxAttempts: 1, params: {} }],
  // Reserved for sub-project #2 (metadata/auto-naming); unused this phase.
  metadata: { title: /From:\s*(.+)/, count: /Page\s+\d+\s*\/\s*(\d+)/i }
};
```

- [ ] **Step 5: Create `src/profiles/generic.mjs`**

```js
// Generic default profile (catch-all): today's behaviour for any site without a
// dedicated profile — a single keyboard-advance pass.
import { ContentType } from "./profile.mjs";

export default {
  name: "generic",
  match: () => true,
  contentType: ContentType.IMAGE,
  pipeline: [{ mechanism: "current", maxAttempts: 2, params: {} }],
  metadata: {}
};
```

- [ ] **Step 6: Run to verify it passes**

Run: `node --test test/profiles.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/profiles/profile.mjs src/profiles/batcave.mjs src/profiles/generic.mjs test/profiles.test.mjs
git commit -m "feat(profiles): profile shape, hostMatch, batcave + generic profiles

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Mechanism factory + profile registry (resolution)

**Files:**
- Modify: `src/strategies/registry.mjs` (add `MECHANISMS`; keep existing exports for now)
- Create: `src/profiles/registry.mjs`
- Test: `test/profile-registry.test.mjs`

**Interfaces:**
- Consumes: `BrowserKeyboardStrategy`, `ChapterAwareStrategy` (Task 1); `batcave`, `generic` (Task 2).
- Produces:
  - `MECHANISMS = { current: (params)=>strategy, "chapter-aware": (params)=>strategy }`
  - `resolveProfile(url, profiles?) → profile`
  - `resolvePipeline(profile, config, logger, mechanisms?) → Array<{ strategy, maxAttempts }>`

- [ ] **Step 1: Write the failing test**

```js
// test/profile-registry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, resolvePipeline } from "../src/profiles/registry.mjs";

const capturingLogger = () => { const warns = []; return { warn: (m) => warns.push(m), warns }; };
// Fake mechanisms so resolution is tested without constructing real strategies.
const fakeMechs = {
  current: (params) => ({ name: "current", defaultMaxAttempts: 2, params }),
  "chapter-aware": (params) => ({ name: "chapter-aware", defaultMaxAttempts: 1, params })
};

test("resolveProfile: batcave URL → batcave, others → generic, bad URL → generic", () => {
  assert.equal(resolveProfile("https://batcave.biz/event/x/1").name, "batcave");
  assert.equal(resolveProfile("https://example.com/x").name, "generic");
  assert.equal(resolveProfile("not a url").name, "generic");
});

test("resolvePipeline: batcave → [chapter-aware x1], generic → [current x2]", () => {
  const bc = resolveProfile("https://batcave.biz/x/1");
  const rb = resolvePipeline(bc, {}, capturingLogger(), fakeMechs);
  assert.deepEqual(rb.map((x) => x.strategy.name), ["chapter-aware"]);
  assert.equal(rb[0].maxAttempts, 1);
  const gen = resolveProfile("https://example.com/x");
  const rg = resolvePipeline(gen, {}, capturingLogger(), fakeMechs);
  assert.deepEqual(rg.map((x) => x.strategy.name), ["current"]);
  assert.equal(rg[0].maxAttempts, 2);
});

test("resolvePipeline: passes params into the mechanism", () => {
  const profile = { pipeline: [{ mechanism: "current", params: { advanceKey: "ArrowDown" } }] };
  const r = resolvePipeline(profile, {}, capturingLogger(), fakeMechs);
  assert.deepEqual(r[0].strategy.params, { advanceKey: "ArrowDown" });
});

test("resolvePipeline: config.strategies overrides the profile pipeline globally", () => {
  const profile = { pipeline: [{ mechanism: "chapter-aware" }] };
  const r = resolvePipeline(profile, { strategies: [{ name: "current", maxAttempts: 1 }] }, capturingLogger(), fakeMechs);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.equal(r[0].maxAttempts, 1);
});

test("resolvePipeline: unknown mechanism is warned and skipped", () => {
  const log = capturingLogger();
  const profile = { pipeline: [{ mechanism: "nope" }, { mechanism: "current" }] };
  const r = resolvePipeline(profile, {}, log, fakeMechs);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.some((m) => /unknown mechanism "nope"/.test(m)));
});

test("resolvePipeline: maxAttempts:0 and enabled:false disable an entry", () => {
  const profile = { pipeline: [{ mechanism: "current", maxAttempts: 0 }, { mechanism: "chapter-aware", enabled: false }] };
  const r = resolvePipeline(profile, {}, capturingLogger(), fakeMechs);
  assert.equal(r.length, 0);
});

test("resolvePipeline: invalid entries are warned and skipped", () => {
  const log = capturingLogger();
  const profile = { pipeline: [null, { maxAttempts: 2 }, { mechanism: "current" }] };
  const r = resolvePipeline(profile, {}, log, fakeMechs);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.length >= 2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/profile-registry.test.mjs`
Expected: FAIL — cannot find module `../src/profiles/registry.mjs`.

- [ ] **Step 3: Add `MECHANISMS` to `src/strategies/registry.mjs`**

Add below the existing `STRATEGY_FACTORIES` (leave the existing exports in place; they are removed in Task 5):
```js
// Mechanism factories: name → (params) => strategy. A profile's pipeline names
// these; `params` are per-site overrides merged over config at execute time.
export const MECHANISMS = {
  current: (params = {}) => new BrowserKeyboardStrategy({ params }),
  "chapter-aware": (params = {}) => new ChapterAwareStrategy({ params })
};
```

- [ ] **Step 4: Create `src/profiles/registry.mjs`**

```js
// Profile registry: resolve a URL to a profile, and a profile to the
// orchestrator's ordered [{ strategy, maxAttempts }] mechanism list.
import batcave from "./batcave.mjs";
import generic from "./generic.mjs";
import { MECHANISMS } from "../strategies/registry.mjs";

// First match wins; `generic` matches everything and is last.
export const PROFILES = [batcave, generic];

export function resolveProfile(url, profiles = PROFILES) {
  for (const p of profiles) {
    try { if (p.match(url)) return p; } catch { /* ignore a bad matcher */ }
  }
  return generic;
}

// Build the mechanism pipeline for a job. A non-empty config.strategies overrides
// the profile's pipeline globally (back-compat); its entries use `name`, a
// profile's entries use `mechanism` — both are accepted.
export function resolvePipeline(profile, config, logger, mechanisms = MECHANISMS) {
  const override = Array.isArray(config?.strategies) && config.strategies.length ? config.strategies : null;
  const specs = override || profile.pipeline || [];
  const out = [];
  for (const spec of specs) {
    const key = spec && (spec.mechanism || spec.name);
    if (!spec || typeof key !== "string") {
      logger?.warn?.(`ignoring invalid pipeline entry: ${JSON.stringify(spec)}`);
      continue;
    }
    if (spec.enabled === false) continue;
    const make = mechanisms[key];
    if (!make) { logger?.warn?.(`unknown mechanism "${key}" — skipping`); continue; }
    const strategy = make(spec.params || {});
    const maxAttempts = Number.isInteger(spec.maxAttempts) ? spec.maxAttempts : (strategy.defaultMaxAttempts ?? 1);
    if (maxAttempts < 1) continue; // 0 disables
    out.push({ strategy, maxAttempts });
  }
  return out;
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `node --test test/profile-registry.test.mjs`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/strategies/registry.mjs src/profiles/registry.mjs test/profile-registry.test.mjs
git commit -m "feat(profiles): mechanism factory + profile registry (resolveProfile/resolvePipeline)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Per-job profile resolution in the pipeline

**Files:**
- Modify: `src/pipeline.mjs` (imports; `BatchRunner` constructor/`run`/`_runJobs`; `scrapeJob`)
- Modify: `src/config.mjs` (comment on `strategies`)
- Modify: `scraper.config.example.json` (document override semantics)
- Test: `test/pipeline.test.mjs` (append)

**Interfaces:**
- Consumes: `resolveProfile`, `resolvePipeline` (Task 3); `ScrapingOrchestrator`, `validate` (existing).
- Produces: `scrapeJob(session, job, config, processor, packagers, uploader, logger, orchestrator, profile)` — new trailing `profile`; result objects gain `contentType`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pipeline.test.mjs`:
```js
test("_runJobs: resolves the profile per job and builds the right pipeline", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const seen = [];
  runner._resolveProfile = (url) => (url.includes("batcave") ? { name: "batcave", contentType: "image" } : { name: "generic", contentType: "image" });
  runner._resolvePipeline = (profile) => [{ strategy: { name: profile.name === "batcave" ? "chapter-aware" : "current" }, maxAttempts: 1 }];
  runner._scrapeJob = async (session, job, config, processor, packagers, uploader, logger, orchestrator, profile) => {
    seen.push({ url: job.url, profile: profile.name, mech: orchestrator.strategies[0].strategy.name });
    return { saved: 1, total: 1, complete: true, contentType: profile.contentType };
  };
  const source = { hasStatus: false, setStatus() {} };
  const jobs = [{ url: "https://batcave.biz/event/x/1", status: "" }, { url: "https://other.example/x", status: "" }];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(seen, [
    { url: "https://batcave.biz/event/x/1", profile: "batcave", mech: "chapter-aware" },
    { url: "https://other.example/x", profile: "generic", mech: "current" }
  ]);
});

test("_runJobs: an empty pipeline marks the row retry and continues the batch", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const statuses = {};
  const ran = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._resolvePipeline = (profile) => (profile.name === "generic" ? [] : [{ strategy: { name: "current" }, maxAttempts: 1 }]);
  runner._scrapeJob = async (s, job) => { ran.push(job.url); return { saved: 1, total: 1, complete: true }; };
  const source = { hasStatus: true, setStatus: (job, v) => { statuses[job.url] = v; } };
  const jobs = [{ url: "https://a/1", status: "", row: 1 }, { url: "https://b/2", status: "", row: 2 }];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(ran, [], "scrapeJob not called when no mechanisms resolve");
  assert.equal(statuses["https://a/1"], "retry");
  assert.equal(statuses["https://b/2"], "retry", "batch continued to the second row");
});

test("scrapeJob: threads the profile's contentType onto the result", async () => {
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const packagers = [{ write: async () => {} }];
  const orchestrator = { run: async () => ({ status: "success", usedStrategy: "current", downloaded: 1, total: 1, attempts: [] }) };
  const r = await scrapeJob({}, { url: "https://x/read" }, config, processor, packagers, null, noopLogger, orchestrator, { name: "generic", contentType: "image" });
  assert.equal(r.complete, true);
  assert.equal(r.contentType, "image");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pipeline.test.mjs`
Expected: the three new tests FAIL (`_resolveProfile`/`_resolvePipeline` not used by `_runJobs` yet; `scrapeJob` ignores the 9th arg and omits `contentType`).

- [ ] **Step 3: Update `src/pipeline.mjs` imports**

Replace the registry import. Change:
```js
import { resolveStrategies } from "./strategies/registry.mjs";
```
to:
```js
import { resolveProfile, resolvePipeline } from "./profiles/registry.mjs";
```
Keep the existing `import { ScrapingOrchestrator } from "./orchestrator.mjs";` and `import { validate } from "./result-validator.mjs";`.

- [ ] **Step 4: Update the `BatchRunner` constructor**

Replace the `_resolveStrategies` seam:
```js
    this._scrapeJob = deps.scrapeJob || scrapeJob;
    this._resolveProfile = deps.resolveProfile || resolveProfile;
    this._resolvePipeline = deps.resolvePipeline || resolvePipeline;
    this._validate = deps.validate || validate;
```

- [ ] **Step 5: Remove the run()-level pipeline build**

In `run()`, delete these lines (the global resolution, empty guard, and orchestrator creation):
```js
    const strategies = this._resolveStrategies(this.config, this.logger);
    if (!strategies.length) {
      this.logger.error("no scraping strategies enabled — check the `strategies` config.");
      return 1;
    }
    const orchestrator = new ScrapingOrchestrator(strategies, this._validate, this.logger);
```
and change the `_runJobs` call to stop passing `orchestrator`:
```js
      results = await this._runJobs({ jobs, source, session, processor, packagers, uploader });
```

- [ ] **Step 6: Resolve per job inside `_runJobs`**

Change the signature to drop `orchestrator`, and build it per job. Replace the per-job body (the `let complete = false; try { ... } catch { ... }` block) with:
```js
  async _runJobs({ jobs, source, session, processor, packagers, uploader }) {
    // ... unchanged loop head (stop flag, skip check, itemDelay, section line) ...

      const profile = this._resolveProfile(job.url);
      const strategies = this._resolvePipeline(profile, this.config, this.logger);
      this.logger.verbose(`profile=${profile.name} contentType=${profile.contentType} pipeline=[${strategies.map((s) => s.strategy.name).join(", ")}]`);

      let complete = false;
      if (!strategies.length) {
        this.logger.error(`no mechanisms resolved for ${job.url} (profile ${profile.name}) — marking retry`);
        results.push({ ...job, saved: 0, ok: false, error: "no mechanisms resolved" });
      } else {
        const orchestrator = new ScrapingOrchestrator(strategies, this._validate, this.logger);
        try {
          const r = await this._scrapeJob(session, job, this.config, processor, packagers, uploader, this.logger, orchestrator, profile);
          complete = r.complete;
          results.push({ ...job, ...r, ok: complete });
        } catch (e) {
          this.logger.error(`failed on ${job.url}: ${e?.message || e}`);
          results.push({ ...job, saved: 0, ok: false, error: String(e?.message || e) });
        }
      }

      // Persist outcome immediately so an interrupted batch is resumable.
      if (source.hasStatus) source.setStatus(job, complete ? "done" : "retry");
    }
    return results;
  }
```

- [ ] **Step 7: Thread `contentType` through `scrapeJob`**

Change the signature and add the content-type guard + field. Signature:
```js
export async function scrapeJob(session, job, config, processor, packagers, uploader, logger, orchestrator, profile) {
```
After the `if (r.status !== "success")` early-return block, before packaging, add:
```js
    const contentType = profile?.contentType || "image";
    if (contentType !== "image") throw new Error(`unsupported contentType "${contentType}" (text output is a future content type)`);
```
Add `contentType` to **all three** result objects (the non-success return, the Drive-upload-failure return, and the success return), e.g. the success return becomes:
```js
    return { saved: outputs.length, total: r.total, complete: true, bytes: meter.bytes, requests: meter.count, usedStrategy: r.usedStrategy, attempts: r.attempts, contentType };
```
For the non-success early return, compute `contentType` at the top of the `try` (move the `const contentType = ...` line to just after `const r = await orchestrator.run(...)`), so it is in scope for every return. (The guard `throw` stays on the success path only — a non-success result returns before packaging regardless.)

- [ ] **Step 8: Update config docs**

In `src/config.mjs`, change the `strategies` default comment to:
```js
  // Per-site profiles choose the scraping pipeline by URL (see src/profiles/).
  // Set `strategies` to OVERRIDE the profile pipeline globally (array of
  // { name, maxAttempts?, enabled? }); null = use the matched profile.
  strategies: null,
```
In `scraper.config.example.json`, replace the `strategies` block comment with:
```jsonc
  // --- Scraping strategies (OVERRIDE; optional) ---
  // By default the pipeline is chosen per-site by a profile (batcave → hash
  // addressing; everything else → keyboard advance). Set this to force a
  // specific pipeline for ALL links instead. Omit to use the per-site profile.
  "strategies": [
    { "name": "current",       "enabled": true, "maxAttempts": 2 },
    { "name": "chapter-aware", "enabled": true, "maxAttempts": 1 }
  ]
```

- [ ] **Step 9: Run the pipeline tests + full suite**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — the three new tests plus all existing `_runJobs`/`decideOutcome`/`describeDryRun`/`scrapeJob` tests (existing `_runJobs` tests construct `new BatchRunner(...)` and inject `_scrapeJob`; the default `_resolveProfile`/`_resolvePipeline` resolve their `https://x/N` URLs to the generic profile → `current`, and the injected `_scrapeJob` ignores the orchestrator).

Run: `npm test`
Expected: PASS — every file green.

- [ ] **Step 10: Commit**

```bash
git add src/pipeline.mjs src/config.mjs scraper.config.example.json test/pipeline.test.mjs
git commit -m "feat(pipeline): resolve the mechanism pipeline per job from a site profile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Remove the superseded global registry + docs

**Files:**
- Modify: `src/strategies/registry.mjs` (remove `STRATEGY_FACTORIES`, `DEFAULT_PIPELINE`, `resolveStrategies`)
- Replace: `test/registry.test.mjs` → delete (its subject is removed; coverage now in `test/profile-registry.test.mjs`)
- Modify: `README.md` (profiles section)

**Interfaces:**
- Consumes: nothing new.
- Produces: `src/strategies/registry.mjs` exporting only `MECHANISMS`.

- [ ] **Step 1: Confirm nothing imports the removed symbols**

Run: `grep -rn "resolveStrategies\|DEFAULT_PIPELINE\|STRATEGY_FACTORIES" src test`
Expected: matches ONLY in `src/strategies/registry.mjs` and `test/registry.test.mjs` (both handled here). If anything else matches, stop — a consumer was missed.

- [ ] **Step 2: Reduce `src/strategies/registry.mjs` to just mechanisms**

```js
// Mechanism factories: name → (params) => strategy. A site profile's pipeline
// (src/profiles/) names these; `params` are per-site overrides merged over config
// at execute time. Adding a mechanism = create its strategy file + one line here.
import { BrowserKeyboardStrategy } from "./browser-keyboard.mjs";
import { ChapterAwareStrategy } from "./chapter-aware.mjs";

export const MECHANISMS = {
  current: (params = {}) => new BrowserKeyboardStrategy({ params }),
  "chapter-aware": (params = {}) => new ChapterAwareStrategy({ params })
};
```

- [ ] **Step 3: Delete the obsolete registry test**

```bash
git rm test/registry.test.mjs
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — no references to the removed symbols; profile-registry tests cover resolution.

- [ ] **Step 5: Update the README**

In `README.md`, revise the "Scraping strategies" section to describe **site profiles**:
- A job's pipeline is chosen by a per-site **profile** (matched by URL); `src/profiles/` holds them.
- Built-ins: **batcave** → `[chapter-aware]` (hash addressing); **generic** (default) → `[current]` (keyboard advance).
- Mechanisms are `current` and `chapter-aware`; a profile entry is `{ mechanism, maxAttempts?, params? }`, where `params` override config per site.
- Adding a site = add `src/profiles/<name>.mjs` (with `match`, `contentType`, `pipeline`, `metadata`) and register it in `src/profiles/registry.mjs`'s `PROFILES`.
- `config.strategies` still **overrides** the profile pipeline globally.
- Note the content-agnostic seam: `contentType` is `"image"` today; text (HTML→Markdown) is a planned future content type.
Verify the names/keys written match `src/profiles/*.mjs` and `scraper.config.example.json`.

- [ ] **Step 6: Commit**

```bash
git add src/strategies/registry.mjs README.md
git commit -m "refactor(strategies): drop global strategy registry superseded by profiles; docs

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite:** `npm test` → all green.
- [ ] **Dry-run smoke (no browser):** `node scrape.mjs https://batcave.biz/event/ultimate-marvel/395 --dry-run` → prints the preview and exits 0.
- [ ] **Live smoke (optional, network):** scrape batcave `/395` with a throwaway config (no drive/cleanup, temp out) → the log shows `profile=batcave pipeline=[chapter-aware]` and SUCCESS 29/29; a non-batcave reader shows `profile=generic pipeline=[current]`.
