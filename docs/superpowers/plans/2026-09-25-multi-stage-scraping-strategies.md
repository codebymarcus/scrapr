# Multi-Stage / Fallback Scraping Strategies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single hard-coded scraping approach with a pluggable, ordered pipeline of strategies that retry within a strategy and fall back to the next one, so a structurally-failing job (e.g. the batcave.biz last-page navigation jump) can be recovered instead of failing identically forever.

**Architecture:** A strategy owns only the *acquire phase* (open + drive the reader into a shared `ImageCapture`/`PageCache`). A `ScrapingOrchestrator` runs resolved strategies in order — retrying a strategy for transient (retryable) failures, then falling back to the next — and a `result-validator` is the single authority on success vs. incomplete. `scrapeJob` calls the orchestrator for the acquire phase; packaging/upload/cleanup are unchanged. Everything is wired through the existing layered JSON config.

**Tech Stack:** Node.js ESM (`.mjs`), Playwright, `node --test` + `node:assert/strict`, dependency injection via constructor/params (matching the existing codebase).

**Spec:** [docs/superpowers/specs/2026-09-25-multi-stage-scraping-strategies-design.md](../specs/2026-09-25-multi-stage-scraping-strategies-design.md)

## Global Constraints

- ES modules only (`"type": "module"`), Node ≥ whatever runs `node --test`; no new runtime dependencies.
- Every module lives under `src/`; strategies under `src/strategies/`. One responsibility per file.
- Tests use `node:test` + `node:assert/strict`, one test file per module under `test/`, and inject fakes (no real browser in unit tests) — mirror `test/pipeline.test.mjs`.
- Config keys are camelCase, layered defaults < JSON file < CLI; a new key added to `DEFAULTS` in `src/config.mjs`.
- Backward compatibility: with `strategies` omitted, behaviour is the default pipeline (`current` → `chapter-aware`); because fallback only fires on a non-success acquire, every job that succeeds today still succeeds identically. `"strategies": [{ "name": "current" }]` restores strict single-strategy behaviour.
- Failure taxonomy is the exact `FailureCode` set from the spec §5. Do not log credentials, cookies, or tokens.
- Commit after each task with a `feat:`/`refactor:`/`test:` message ending with the attribution line:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Review Focus

- **Unknown / misspelled strategy name in config** → `resolveStrategies` must warn and skip it, never throw (pinned in Task 6).
- **No strategies resolve (all disabled, `maxAttempts: 0`, or empty array)** → `BatchRunner.run()` errors out cleanly with exit code 1, and `ScrapingOrchestrator.run()` returns a `failed` result rather than crashing or falsely succeeding (pinned in Tasks 4 and 6).
- **A strategy's `execute()` throws instead of returning a result** → the orchestrator catches it, maps it to a `FailureCode`, and treats it as that attempt's failure (pinned in Task 4).
- **`maxAttempts: 0` on an enabled strategy** → treated as disabled (skipped), not "run infinitely" or "run once" (pinned in Task 6).
- **Total page count over-detected so even a capped drive still jumps** → `chapter-aware` detects the URL jump, stops, and returns what it has (non-zero) rather than looping or throwing (pinned in Task 5).

---

## Task 1: Strategy contract, result constructors, failure taxonomy

**Files:**
- Create: `src/strategies/strategy.mjs`
- Test: `test/strategy.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `FailureCode` — frozen object of code strings.
  - `ok(data = {}, metadata = {}) → { status: "success", data, metadata }`
  - `partial(data = {}, code = FailureCode.INCOMPLETE_RESULT, message = "", metadata = {}) → { status: "incomplete", data, error: { code, message }, metadata }`
  - `failed(code = FailureCode.UNKNOWN_ERROR, message = "", metadata = {}) → { status: "failed", error: { code, message }, metadata }`
  - `isRetryable(code) → boolean`
  - `mapError(err) → FailureCode`

- [ ] **Step 1: Write the failing test**

```js
// test/strategy.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { FailureCode, ok, partial, failed, isRetryable, mapError } from "../src/strategies/strategy.mjs";

test("result constructors carry the right status and payload", () => {
  assert.deepEqual(ok({ downloaded: 3, total: 3 }), { status: "success", data: { downloaded: 3, total: 3 }, metadata: {} });
  const p = partial({ downloaded: 1, total: 3 });
  assert.equal(p.status, "incomplete");
  assert.equal(p.error.code, FailureCode.INCOMPLETE_RESULT);
  const f = failed(FailureCode.TIMEOUT, "slow");
  assert.deepEqual(f, { status: "failed", error: { code: "TIMEOUT", message: "slow" }, metadata: {} });
});

test("isRetryable: only transient transport failures are retryable", () => {
  for (const c of [FailureCode.TIMEOUT, FailureCode.NETWORK_ERROR, FailureCode.HTTP_ERROR, FailureCode.RATE_LIMITED])
    assert.equal(isRetryable(c), true, `${c} should retry`);
  for (const c of [FailureCode.INCOMPLETE_RESULT, FailureCode.NAVIGATION_JUMP, FailureCode.BLOCKED, FailureCode.EMPTY_RESULT])
    assert.equal(isRetryable(c), false, `${c} should NOT retry`);
});

test("mapError classifies thrown errors", () => {
  assert.equal(mapError({ name: "TimeoutError", message: "Timeout 30000ms exceeded" }), FailureCode.TIMEOUT);
  assert.equal(mapError(new Error("net::ERR_CONNECTION_RESET")), FailureCode.NETWORK_ERROR);
  assert.equal(mapError(new Error("something else")), FailureCode.UNKNOWN_ERROR);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/strategy.test.mjs`
Expected: FAIL — cannot find module `../src/strategies/strategy.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/strategies/strategy.mjs
// The scraping-strategy contract shared by every strategy and the orchestrator.
// A strategy is one *way* to acquire a chapter's pages into a shared ImageCapture;
// it returns a ScrapingResult the orchestrator acts on without knowing internals.

export const FailureCode = Object.freeze({
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  HTTP_ERROR: "HTTP_ERROR",
  BLOCKED: "BLOCKED",
  RATE_LIMITED: "RATE_LIMITED",
  EMPTY_RESULT: "EMPTY_RESULT",
  INCOMPLETE_RESULT: "INCOMPLETE_RESULT",
  NAVIGATION_JUMP: "NAVIGATION_JUMP",
  PARSER_ERROR: "PARSER_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR"
});

// ScrapingResult constructors. `data` carries { downloaded, total }; the
// validator (not the strategy) is the authority on success vs incomplete, so a
// non-failed strategy returns ok(data) and lets the validator classify.
export const ok = (data = {}, metadata = {}) => ({ status: "success", data, metadata });
export const partial = (data = {}, code = FailureCode.INCOMPLETE_RESULT, message = "", metadata = {}) =>
  ({ status: "incomplete", data, error: { code, message }, metadata });
export const failed = (code = FailureCode.UNKNOWN_ERROR, message = "", metadata = {}) =>
  ({ status: "failed", error: { code, message }, metadata });

// Retryable = transient transport failures worth re-running the SAME strategy.
// Structural failures (incomplete, navigation jump, blocked, empty) are NOT
// retryable — repeating the same approach reproduces them — so the orchestrator
// falls back to the next strategy instead.
const RETRYABLE = new Set([
  FailureCode.TIMEOUT,
  FailureCode.NETWORK_ERROR,
  FailureCode.HTTP_ERROR,
  FailureCode.RATE_LIMITED
]);
export const isRetryable = (code) => RETRYABLE.has(code);

// Map a thrown Playwright/runtime error to a FailureCode.
export function mapError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (err?.name === "TimeoutError" || msg.includes("timeout")) return FailureCode.TIMEOUT;
  if (msg.includes("net::") || msg.includes("econn") || msg.includes("socket") || msg.includes("dns") || msg.includes("network"))
    return FailureCode.NETWORK_ERROR;
  return FailureCode.UNKNOWN_ERROR;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/strategy.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/strategies/strategy.mjs test/strategy.test.mjs
git commit -m "feat: scraping-strategy contract, result constructors, failure taxonomy

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Extract `decideOutcome` into `src/outcome.mjs`

Breaks the would-be `pipeline.mjs ↔ result-validator.mjs` import cycle by moving the pure `decideOutcome` helper out of `pipeline.mjs`. `pipeline.mjs` re-exports it so existing imports keep working.

**Files:**
- Create: `src/outcome.mjs`
- Modify: `src/pipeline.mjs` (remove the inline `decideOutcome`; add a re-export)
- Test: reuse `test/pipeline.test.mjs` (already imports `decideOutcome` from `../src/pipeline.mjs`)

**Interfaces:**
- Consumes: nothing.
- Produces: `decideOutcome({ downloaded, total, seeded, acceptPartial }) → { complete, acceptedPartial, stagnant }` (identical behaviour to today).

- [ ] **Step 1: Create `src/outcome.mjs` with the function moved verbatim**

```js
// src/outcome.mjs
// Decide a download's outcome from the counts. `seeded` is how many pages were
// already in the cache before this run; `downloaded` is the total now held.
//   - complete: enough pages to package (reached total, or total unknown).
//   - stagnant: an incomplete rerun that produced no new pages — the reader has
//     nothing more to give (over-counted total, or a genuinely missing page).
//   - acceptedPartial: a stagnant rerun the user chose to keep (--accept-partial).
export function decideOutcome({ downloaded, total, seeded, acceptPartial }) {
  const complete = downloaded > 0 && (!(total > 0) || downloaded >= total);
  if (complete) return { complete: true, acceptedPartial: false, stagnant: false };
  const stagnant = seeded > 0 && downloaded - seeded <= 0;
  if (stagnant && acceptPartial && downloaded > 0) {
    return { complete: true, acceptedPartial: true, stagnant: true };
  }
  return { complete: false, acceptedPartial: false, stagnant };
}
```

- [ ] **Step 2: In `src/pipeline.mjs`, delete the inline `decideOutcome` definition** (the `export function decideOutcome(...) { ... }` block, currently around lines 66–74).

- [ ] **Step 3: In `src/pipeline.mjs`, import `decideOutcome` and re-export it.** Add near the other imports at the top of the file:

```js
import { decideOutcome } from "./outcome.mjs";
export { decideOutcome };
```

The **import** gives a local binding so `scrapeJob`'s existing inline call to `decideOutcome(...)` keeps working until Task 7 rewrites that body; the **export** keeps the public `decideOutcome` that `test/pipeline.test.mjs` imports.

- [ ] **Step 4: Run the existing pipeline tests to verify nothing broke**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — all `decideOutcome` tests still pass via the re-export.

- [ ] **Step 5: Commit**

```bash
git add src/outcome.mjs src/pipeline.mjs
git commit -m "refactor: extract decideOutcome into outcome.mjs to break import cycle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Result validator

The single authority on completeness, composed from `decideOutcome` + `missingPages`, separate from every strategy.

**Files:**
- Create: `src/result-validator.mjs`
- Test: `test/result-validator.test.mjs`

**Interfaces:**
- Consumes: `decideOutcome` (Task 2), `missingPages` from `src/processor.mjs`, `FailureCode` (Task 1).
- Produces: `validate({ downloaded, total, seeded = 0, images = [], acceptPartial = false }) → { status: "success"|"incomplete"|"failed", code?, downloaded, total, missing, stagnant }`.

- [ ] **Step 1: Write the failing test**

```js
// test/result-validator.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/result-validator.mjs";

const img = (n) => ({ url: `https://s/x/394/${n}-abc.jpg` });

test("success when the page count is reached", () => {
  const v = validate({ downloaded: 3, total: 3, images: [img(1), img(2), img(3)] });
  assert.equal(v.status, "success");
  assert.deepEqual(v.missing, []);
});

test("success when total is unknown but pages were captured", () => {
  const v = validate({ downloaded: 5, total: 0 });
  assert.equal(v.status, "success");
});

test("failed with EMPTY_RESULT when nothing was captured", () => {
  const v = validate({ downloaded: 0, total: 3 });
  assert.equal(v.status, "failed");
  assert.equal(v.code, "EMPTY_RESULT");
});

test("incomplete lists the missing pages", () => {
  const v = validate({ downloaded: 2, total: 3, images: [img(1), img(2)] });
  assert.equal(v.status, "incomplete");
  assert.equal(v.code, "INCOMPLETE_RESULT");
  assert.deepEqual(v.missing, [3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/result-validator.test.mjs`
Expected: FAIL — cannot find module `../src/result-validator.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/result-validator.mjs
// Judge an acquire pass's completeness from the shared capture's counts — the
// single authority every strategy is measured by, kept separate from the
// strategies so "how to scrape" and "is it valid" stay independent.
import { decideOutcome } from "./outcome.mjs";
import { missingPages } from "./processor.mjs";
import { FailureCode } from "./strategies/strategy.mjs";

export function validate({ downloaded, total, seeded = 0, images = [], acceptPartial = false }) {
  const t = total || 0;
  if (!(downloaded > 0)) {
    return { status: "failed", code: FailureCode.EMPTY_RESULT, downloaded: downloaded || 0, total: t, missing: [], stagnant: false };
  }
  const o = decideOutcome({ downloaded, total, seeded, acceptPartial });
  if (o.complete) return { status: "success", downloaded, total: t, missing: [], stagnant: o.stagnant };
  return { status: "incomplete", code: FailureCode.INCOMPLETE_RESULT, downloaded, total: t, missing: missingPages(images, total), stagnant: o.stagnant };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/result-validator.test.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/result-validator.mjs test/result-validator.test.mjs
git commit -m "feat: result validator (success/incomplete/empty) separate from strategies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Orchestrator (retry-within-strategy, fallback-to-next)

**Files:**
- Create: `src/orchestrator.mjs`
- Test: `test/orchestrator.test.mjs`

**Interfaces:**
- Consumes: `isRetryable`, `failed`, `mapError`, `FailureCode` (Task 1); `formatPageList` from `src/processor.mjs`; an injected `validate` (Task 3 shape).
- Produces:
  - `class ScrapingOrchestrator { constructor(strategies, validate, logger); async run(ctx) }`
    - `strategies`: `[{ strategy, maxAttempts }]` (already resolved & ordered).
    - `ctx`: `{ session, job, config, capture, meter, seeded }`.
    - returns `{ status: "success"|"failed", usedStrategy: string|null, downloaded, total, attempts: [{ name, attempt, status, code, downloaded, total, durationMs }] }`.
  - `reportFailure(logger, job, attempts)` — prints the final-failure table.

- [ ] **Step 1: Write the failing test (the fallback matrix)**

```js
// test/orchestrator.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ScrapingOrchestrator } from "../src/orchestrator.mjs";
import { ok, failed, FailureCode } from "../src/strategies/strategy.mjs";

const noopLogger = { info() {}, warn() {}, success() {}, error() {}, muted() {}, step() {}, section() {} };

// A fake strategy that returns scripted results per attempt and counts its calls.
function fakeStrategy(name, script) {
  let i = 0;
  const s = { name, defaultMaxAttempts: 1, calls: 0, execute: async () => { s.calls++; return script[Math.min(i++, script.length - 1)]; } };
  return s;
}

// Stub validator: classify by counts (downloaded vs total).
const validate = ({ downloaded, total }) => {
  if (!(downloaded > 0)) return { status: "failed", code: "EMPTY_RESULT", downloaded: 0, total: total || 0, missing: [] };
  if (!total || downloaded >= total) return { status: "success", downloaded, total: total || 0, missing: [] };
  return { status: "incomplete", code: "INCOMPLETE_RESULT", downloaded, total, missing: [] };
};

const ctx = { job: { url: "u" }, config: {}, seeded: 0, capture: { size: 0, list: () => [] } };
const run = (pairs) => new ScrapingOrchestrator(pairs, validate, noopLogger).run(ctx);

test("first strategy succeeds → later strategies not executed", async () => {
  const A = fakeStrategy("A", [ok({ downloaded: 10, total: 10 })]);
  const B = fakeStrategy("B", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 2 }, { strategy: B, maxAttempts: 1 }]);
  assert.equal(r.status, "success");
  assert.equal(r.usedStrategy, "A");
  assert.equal(B.calls, 0);
  assert.equal(r.attempts.length, 1);
});

test("first fails → falls back → second succeeds", async () => {
  const A = fakeStrategy("A", [failed(FailureCode.BLOCKED, "blocked")]);
  const B = fakeStrategy("B", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 1 }, { strategy: B, maxAttempts: 1 }]);
  assert.equal(r.status, "success");
  assert.equal(r.usedStrategy, "B");
  assert.deepEqual(r.attempts.map((a) => a.status), ["failed", "success"]);
});

test("first incomplete → falls back (incomplete never retries the same strategy)", async () => {
  const A = fakeStrategy("A", [ok({ downloaded: 5, total: 10 })]);
  const B = fakeStrategy("B", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 2 }, { strategy: B, maxAttempts: 1 }]);
  assert.equal(r.usedStrategy, "B");
  assert.equal(A.calls, 1, "A not retried on incomplete");
});

test("retryable failure retries the SAME strategy, then succeeds", async () => {
  const A = fakeStrategy("A", [failed(FailureCode.TIMEOUT, "t"), ok({ downloaded: 10, total: 10 })]);
  const B = fakeStrategy("B", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 2 }, { strategy: B, maxAttempts: 1 }]);
  assert.equal(r.usedStrategy, "A");
  assert.equal(A.calls, 2);
  assert.equal(B.calls, 0);
});

test("retryable failure exhausts attempts, then falls back", async () => {
  const A = fakeStrategy("A", [failed(FailureCode.TIMEOUT), failed(FailureCode.TIMEOUT)]);
  const B = fakeStrategy("B", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 2 }, { strategy: B, maxAttempts: 1 }]);
  assert.equal(A.calls, 2);
  assert.equal(r.usedStrategy, "B");
});

test("non-retryable failure does NOT retry, even with attempts left", async () => {
  const A = fakeStrategy("A", [failed(FailureCode.BLOCKED)]);
  const B = fakeStrategy("B", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 3 }, { strategy: B, maxAttempts: 1 }]);
  assert.equal(A.calls, 1, "blocked is not retried");
  assert.equal(r.usedStrategy, "B");
});

test("all strategies fail → final FAILED, every attempt recorded", async () => {
  const A = fakeStrategy("A", [failed(FailureCode.BLOCKED)]);
  const B = fakeStrategy("B", [ok({ downloaded: 0, total: 10 })]); // validator → EMPTY/failed
  const C = fakeStrategy("C", [failed(FailureCode.TIMEOUT)]);
  const r = await run([{ strategy: A, maxAttempts: 1 }, { strategy: B, maxAttempts: 1 }, { strategy: C, maxAttempts: 1 }]);
  assert.equal(r.status, "failed");
  assert.equal(r.usedStrategy, null);
  assert.equal(r.attempts.length, 3);
});

test("empty strategy list → FAILED, not a crash", async () => {
  const r = await run([]);
  assert.equal(r.status, "failed");
  assert.deepEqual(r.attempts, []);
});

test("a strategy that throws is caught and treated as a failed attempt", async () => {
  const A = { name: "A", defaultMaxAttempts: 1, execute: async () => { throw new Error("boom"); } };
  const B = fakeStrategy("B", [ok({ downloaded: 10, total: 10 })]);
  const r = await run([{ strategy: A, maxAttempts: 1 }, { strategy: B, maxAttempts: 1 }]);
  assert.equal(r.attempts[0].status, "failed");
  assert.equal(r.usedStrategy, "B");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/orchestrator.test.mjs`
Expected: FAIL — cannot find module `../src/orchestrator.mjs`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/orchestrator.mjs
// The orchestrator decides WHICH strategy runs next: it retries a strategy for
// transient (retryable) failures up to its maxAttempts, then falls back to the
// next strategy. It stops on the first valid result and records every attempt.
// It contains no strategy-specific scraping logic.
import { isRetryable, failed, mapError, FailureCode } from "./strategies/strategy.mjs";
import { formatPageList } from "./processor.mjs";

export class ScrapingOrchestrator {
  // strategies: [{ strategy, maxAttempts }] (resolved & ordered)
  // validate:   the result-validator function (injected for testability)
  constructor(strategies, validate, logger) {
    this.strategies = strategies;
    this.validate = validate;
    this.logger = logger;
  }

  async run(ctx) {
    const attempts = [];
    const N = this.strategies.length;
    let last = { downloaded: 0, total: 0 };

    for (let s = 0; s < N; s++) {
      const { strategy, maxAttempts } = this.strategies[s];
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.logger.info(`[${s + 1}/${N}] strategy=${strategy.name} attempt ${attempt}/${maxAttempts}`);
        const t0 = Date.now();
        let res;
        try {
          // Inject the orchestrator's logger so every strategy logs consistently,
          // regardless of what the caller put in ctx.
          res = await strategy.execute({ ...ctx, logger: this.logger });
        } catch (e) {
          res = failed(mapError(e), e?.message);
        }
        const durationMs = Date.now() - t0;

        let status, code, downloaded, total, missing = [];
        if (res.status === "failed") {
          status = "failed";
          code = res.error?.code ?? FailureCode.UNKNOWN_ERROR;
          downloaded = res.data?.downloaded ?? ctx.capture.size;
          total = res.data?.total ?? last.total;
        } else {
          const v = this.validate({
            downloaded: res.data?.downloaded ?? ctx.capture.size,
            total: res.data?.total,
            seeded: ctx.seeded,
            images: ctx.capture.list(),
            acceptPartial: ctx.config?.acceptPartial
          });
          status = v.status;
          code = v.code;
          downloaded = v.downloaded;
          total = v.total;
          missing = v.missing || [];
        }
        last = { downloaded, total };
        attempts.push({ name: strategy.name, attempt, status, code, downloaded, total, durationMs });
        this.logger.info(`      → ${status.toUpperCase()} (${downloaded}/${total || "?"})`);
        if (status === "incomplete" && missing.length) this.logger.warn(`      missing page(s): ${formatPageList(missing)}`);

        if (status === "success") {
          this.logger.success(`✓ completed using strategy: ${strategy.name}`);
          return { status: "success", usedStrategy: strategy.name, downloaded, total, attempts };
        }
        // Retry the SAME strategy only for retryable transport failures.
        if (status === "failed" && isRetryable(code) && attempt < maxAttempts) continue;
        break; // otherwise fall back to the next strategy
      }
    }

    reportFailure(this.logger, ctx.job, attempts);
    return { status: "failed", usedStrategy: null, downloaded: last.downloaded, total: last.total, attempts };
  }
}

// The final-failure table: one line per recorded attempt.
export function reportFailure(logger, job, attempts) {
  logger.warn(`✗ failed: ${job?.url ?? ""}`);
  logger.warn("  strategies attempted:");
  attempts.forEach((a, i) => {
    const detail = a.code ? a.code : `${a.downloaded}/${a.total || "?"}`;
    logger.warn(`    ${i + 1}. ${a.name} (attempt ${a.attempt}) → ${a.status.toUpperCase()} (${detail})`);
  });
  logger.warn("  final status: FAILED");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/orchestrator.test.mjs`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator.mjs test/orchestrator.test.mjs
git commit -m "feat: scraping orchestrator with retry-within-strategy and fallback-to-next

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Stage 1 (`current`) and Stage 2 (`chapter-aware`) strategies

Two files, but one task: both implement the same contract, and Stage 2's whole reason to exist is understood against Stage 1. Collaborators (`openReader`, `ReaderDriver`, `navigateWithRetry`) are injected so both are unit-testable without a real browser.

**Files:**
- Create: `src/strategies/browser-keyboard.mjs`
- Create: `src/strategies/chapter-aware.mjs`
- Test: `test/browser-keyboard.test.mjs`
- Test: `test/chapter-aware.test.mjs`

**Interfaces:**
- Consumes: `ok`, `failed`, `mapError`, `FailureCode` (Task 1); `openReader`, `navigateWithRetry` from `src/navigation.mjs`; `ReaderDriver` from `src/reader.mjs`; `sleep`, `withJitter` from `src/time.mjs`.
- Produces:
  - `class BrowserKeyboardStrategy { name = "current"; defaultMaxAttempts = 2; execute(ctx) }`
  - `class ChapterAwareStrategy { name = "chapter-aware"; defaultMaxAttempts = 1; execute(ctx) }`
  - `sameIssue(a, b) → boolean` (exported from `chapter-aware.mjs`).
  - Both `execute(ctx)` take `{ session, job, config, capture, meter, logger }` and return a `ScrapingResult`.

- [ ] **Step 1: Write the failing test for Stage 1**

```js
// test/browser-keyboard.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserKeyboardStrategy } from "../src/strategies/browser-keyboard.mjs";

const noopLogger = { info() {}, warn() {}, success() {}, error() {}, verbose() {}, debug() {} };
const fakePage = () => ({ closed: false, async close() { this.closed = true; } });
const fakeCtx = (capture, page) => ({
  session: { newPage: async () => page },
  job: { url: "https://s/x/394" },
  config: {},
  capture,
  meter: { attach() {} },
  logger: noopLogger
});

test("current: returns ok with the captured counts", async () => {
  const page = fakePage();
  const capture = { attach: async () => {}, size: 40, list: () => [] };
  const strat = new BrowserKeyboardStrategy({
    openReader: async () => {},
    ReaderDriver: class { async run() { return { total: 40 }; } }
  });
  const res = await strat.execute(fakeCtx(capture, page));
  assert.equal(res.status, "success");
  assert.deepEqual(res.data, { downloaded: 40, total: 40 });
  assert.equal(page.closed, true, "page is always closed");
});

test("current: maps a thrown timeout to a failed result", async () => {
  const page = fakePage();
  const capture = { attach: async () => {}, size: 0, list: () => [] };
  const strat = new BrowserKeyboardStrategy({
    openReader: async () => { const e = new Error("Timeout 45000ms exceeded"); e.name = "TimeoutError"; throw e; },
    ReaderDriver: class { async run() { return { total: 0 }; } }
  });
  const res = await strat.execute(fakeCtx(capture, page));
  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "TIMEOUT");
  assert.equal(page.closed, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/browser-keyboard.test.mjs`
Expected: FAIL — cannot find module `../src/strategies/browser-keyboard.mjs`.

- [ ] **Step 3: Implement Stage 1**

```js
// src/strategies/browser-keyboard.mjs
// Stage 1: the existing flow, unchanged in behaviour — open the reader past its
// JS gate, then press the advance key through the virtualized reader while the
// shared ImageCapture collects images. Collaborators are injectable for testing.
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { ReaderDriver as DefaultReaderDriver } from "../reader.mjs";
import { ok, failed, mapError } from "./strategy.mjs";

export class BrowserKeyboardStrategy {
  constructor({ openReader = defaultOpenReader, ReaderDriver = DefaultReaderDriver } = {}) {
    this.name = "current";
    this.defaultMaxAttempts = 2;
    this._openReader = openReader;
    this._ReaderDriver = ReaderDriver;
  }

  async execute({ session, job, config, capture, meter, logger }) {
    const page = await session.newPage();
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, config, logger);
      const { total } = await new this._ReaderDriver(page, capture, config, logger).run();
      return ok({ downloaded: capture.size, total });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/browser-keyboard.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for `sameIssue` and Stage 2**

```js
// test/chapter-aware.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChapterAwareStrategy, sameIssue } from "../src/strategies/chapter-aware.mjs";

const noopLogger = { info() {}, warn() {}, success() {}, error() {}, verbose() {}, debug() {}, progressBar() {} };

test("sameIssue: same chapter path (differing hash/query) is the same issue", () => {
  assert.equal(sameIssue("https://batcave.biz/event/ultimate-marvel/394", "https://batcave.biz/event/ultimate-marvel/394#p=5"), true);
  assert.equal(sameIssue("https://batcave.biz/event/ultimate-marvel/394", "https://batcave.biz/event/ultimate-marvel/394?page=5"), true);
});

test("sameIssue: the next-chapter jump (394 → 395) is a DIFFERENT issue", () => {
  assert.equal(sameIssue("https://batcave.biz/event/ultimate-marvel/394", "https://batcave.biz/event/ultimate-marvel/395"), false);
});

// A controllable fake reader page. capture.size grows one per press (page 1 is
// already loaded on open), simulating pages rendering as we advance.
function fakeReader({ total, jumpAtPress = null }) {
  let presses = 0;
  let url = "https://batcave.biz/event/ultimate-marvel/394";
  const page = {
    _presses: () => presses,
    url: () => url,
    async evaluate() { return total; },       // detectTotal count
    mouse: { click: async () => {} },
    keyboard: { press: async () => { presses++; if (jumpAtPress && presses >= jumpAtPress) url = "https://batcave.biz/event/ultimate-marvel/395"; } },
    async waitForTimeout() {},
    closed: false,
    async close() { this.closed = true; }
  };
  const capture = { attach: async () => {}, takeBackoff: () => 0, list: () => [], get size() { return Math.min(presses + 1, total); } };
  return { page, capture };
}

test("chapter-aware: accurate total → reaches the last page without jumping", async () => {
  const { page, capture } = fakeReader({ total: 5, jumpAtPress: null });
  let recovered = false;
  const strat = new ChapterAwareStrategy({
    openReader: async () => {},
    navigateWithRetry: async () => { recovered = true; }
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: page.url() }, config: { settle: 10, jitter: 0 },
    capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(res.status, "success");
  assert.equal(res.data.downloaded, 5);
  assert.equal(recovered, false, "no recovery needed when total is accurate");
});

test("chapter-aware: over-detected total → detects the jump, recovers, returns what it has", async () => {
  const { page, capture } = fakeReader({ total: 6, jumpAtPress: 3 });
  let recovered = false;
  const strat = new ChapterAwareStrategy({
    openReader: async () => {},
    navigateWithRetry: async () => { recovered = true; }
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: "https://batcave.biz/event/ultimate-marvel/394" },
    config: { settle: 10, jitter: 0 }, capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(recovered, true, "recovery ran on the detected jump");
  assert.ok(res.data.downloaded > 0, "keeps the pages captured before the jump");
  assert.equal(page.closed, true);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test test/chapter-aware.test.mjs`
Expected: FAIL — cannot find module `../src/strategies/chapter-aware.mjs`.

- [ ] **Step 7: Implement Stage 2**

```js
// src/strategies/chapter-aware.mjs
// Stage 2 (the real fallback): the batcave.biz reader auto-navigates to the NEXT
// chapter URL when you press past the last page, so Stage 1 loses the true last
// page and reports e.g. 39/40 forever. This strategy avoids that by (a) using a
// longer settle so the last page's image finishes loading, (b) never pressing
// past the last page when the count is known, and (c) if the reader still jumps
// (over-detected count), detecting the URL change, navigating back, and stopping
// with whatever it has. It shares the same ImageCapture, so it only needs to
// pick up pages Stage 1 missed. Collaborators are injectable for testing.
import { openReader as defaultOpenReader, navigateWithRetry as defaultNavigateWithRetry } from "../navigation.mjs";
import { sleep, withJitter } from "../time.mjs";
import { ok, failed, mapError, FailureCode } from "./strategy.mjs";

const STAGNANT_LIMIT = 5;

// Two reader URLs are the same issue when origin + pathname match (ignoring hash
// and query, which readers use for in-chapter page state). The next-chapter jump
// changes the pathname (.../394 → .../395), so it is detected as a different issue.
export function sameIssue(a, b) {
  const key = (u) => {
    try {
      const x = new URL(u);
      return x.origin + x.pathname.replace(/\/$/, "");
    } catch {
      return u;
    }
  };
  return key(a) === key(b);
}

export class ChapterAwareStrategy {
  constructor({ openReader = defaultOpenReader, navigateWithRetry = defaultNavigateWithRetry } = {}) {
    this.name = "chapter-aware";
    this.defaultMaxAttempts = 1;
    this._openReader = openReader;
    this._navigateWithRetry = navigateWithRetry;
  }

  async execute({ session, job, config, capture, meter, logger }) {
    const page = await session.newPage();
    try {
      await capture.attach(page);
      meter?.attach?.(page);
      await this._openReader(page, job.url, config, logger);
      const openUrl = page.url() || job.url;
      const { total, jumped } = await this._drive(page, capture, config, logger, openUrl);
      const downloaded = capture.size;
      if (!(downloaded > 0)) return failed(jumped ? FailureCode.NAVIGATION_JUMP : FailureCode.EMPTY_RESULT, "no pages captured");
      return ok({ downloaded, total });
    } catch (e) {
      return failed(mapError(e), e?.message);
    } finally {
      await page.close().catch(() => {});
    }
  }

  async detectTotal(page, config) {
    if (config.forcePages) return config.forcePages;
    return page.evaluate((sel) => document.querySelectorAll(sel).length, config.countSelector).catch(() => 0);
  }

  async _drive(page, capture, config, logger, openUrl) {
    const total = await this.detectTotal(page, config);
    const target = total && total > 0 ? total : Infinity;
    // Never press PAST the last page when the count is known: total-1 presses take
    // page 1 → page `total`. A longer settle lets that last page's image load.
    const budget = total && total > 0 ? total - 1 : 600;
    // A longer settle than Stage 1 so the last page's image finishes loading
    // before we would otherwise advance. Driven by config.settle (kept small in
    // tests), doubled; defaults to 700 → 1400ms in production.
    const endSettle = (config.settle || 700) * 2;

    await page.mouse.click(640, 450).catch(() => {}); // give the reader keyboard focus
    await page.waitForTimeout(300);

    let stagnant = 0;
    let last = capture.size;
    let jumped = false;
    logger.progressBar?.(capture.size, total, "pages");

    for (let i = 0; i < budget; i++) {
      if (capture.size >= target) break;
      const before = page.url();
      await page.keyboard.press(config.advanceKey).catch(() => {});
      await sleep(withJitter(endSettle, config.jitter));
      const after = page.url();

      if (!sameIssue(before, after)) {
        // Over-detected count still pressed us into the next chapter. Go back to
        // the reader, let the last page settle, and stop with what we have.
        logger.warn(`end-of-chapter jump detected (${after}); recovering and stopping`);
        jumped = true;
        await this._navigateWithRetry(page, openUrl, config, logger);
        await sleep(withJitter(endSettle, config.jitter));
        break;
      }

      const backoff = capture.takeBackoff?.() || 0;
      if (backoff > 0) {
        logger.warn(`rate-limited by server; pausing ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
      }

      if (capture.size === last) {
        if (++stagnant >= STAGNANT_LIMIT) break;
      } else {
        stagnant = 0;
        last = capture.size;
      }
      logger.progressBar?.(capture.size, total, "pages");
    }

    await page.waitForTimeout(1000); // let the last page's image finish loading
    return { total, jumped };
  }
}
```

- [ ] **Step 8: Run both strategy test files to verify they pass**

Run: `node --test test/browser-keyboard.test.mjs test/chapter-aware.test.mjs`
Expected: PASS (Stage 1: 2 tests; Stage 2: 4 tests).

- [ ] **Step 9: Commit**

```bash
git add src/strategies/browser-keyboard.mjs src/strategies/chapter-aware.mjs test/browser-keyboard.test.mjs test/chapter-aware.test.mjs
git commit -m "feat: browser-keyboard (Stage 1) and chapter-aware (Stage 2) strategies

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Strategy registry + `strategies` config key

**Files:**
- Create: `src/strategies/registry.mjs`
- Modify: `src/config.mjs` (add `strategies: null` to `DEFAULTS`)
- Test: `test/registry.test.mjs`
- Test: extend `test/config.test.mjs` (or create it if absent) with a `strategies` case

**Interfaces:**
- Consumes: `BrowserKeyboardStrategy`, `ChapterAwareStrategy` (Task 5).
- Produces:
  - `STRATEGY_FACTORIES` — `{ [name]: () => strategyInstance }`.
  - `DEFAULT_PIPELINE` — `[{ name: "current", maxAttempts: 2 }, { name: "chapter-aware", maxAttempts: 1 }]`.
  - `resolveStrategies(config, logger, factories = STRATEGY_FACTORIES) → [{ strategy, maxAttempts }]`.

- [ ] **Step 1: Write the failing test**

```js
// test/registry.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStrategies, DEFAULT_PIPELINE } from "../src/strategies/registry.mjs";

const capturingLogger = () => { const warns = []; return { warn: (m) => warns.push(m), warns }; };
// Cheap fake factories so registry logic is tested in isolation from strategies.
const factories = {
  current: () => ({ name: "current", defaultMaxAttempts: 2 }),
  "chapter-aware": () => ({ name: "chapter-aware", defaultMaxAttempts: 1 })
};

test("null strategies → the default pipeline, in order", () => {
  const r = resolveStrategies({ strategies: null }, capturingLogger(), factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current", "chapter-aware"]);
  assert.deepEqual(r.map((x) => x.maxAttempts), [2, 1]);
});

test("DEFAULT_PIPELINE matches the spec order and attempts", () => {
  assert.deepEqual(DEFAULT_PIPELINE, [{ name: "current", maxAttempts: 2 }, { name: "chapter-aware", maxAttempts: 1 }]);
});

test("enabled:false entries are skipped", () => {
  const r = resolveStrategies({ strategies: [{ name: "current", enabled: false }, { name: "chapter-aware" }] }, capturingLogger(), factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["chapter-aware"]);
  assert.equal(r[0].maxAttempts, 1, "falls back to defaultMaxAttempts");
});

test("maxAttempts:0 disables a strategy", () => {
  const r = resolveStrategies({ strategies: [{ name: "current", maxAttempts: 0 }] }, capturingLogger(), factories);
  assert.equal(r.length, 0);
});

test("unknown strategy name is warned and skipped", () => {
  const log = capturingLogger();
  const r = resolveStrategies({ strategies: [{ name: "nope" }, { name: "current" }] }, log, factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.some((m) => /unknown strategy "nope"/.test(m)));
});

test("invalid entries are warned and skipped", () => {
  const log = capturingLogger();
  const r = resolveStrategies({ strategies: [null, { maxAttempts: 2 }, { name: "current" }] }, log, factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.length >= 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/registry.test.mjs`
Expected: FAIL — cannot find module `../src/strategies/registry.mjs`.

- [ ] **Step 3: Implement the registry**

```js
// src/strategies/registry.mjs
// Maps configured strategy names to instances and resolves the ordered pipeline.
// Adding a strategy = create its file + add one line to STRATEGY_FACTORIES.
import { BrowserKeyboardStrategy } from "./browser-keyboard.mjs";
import { ChapterAwareStrategy } from "./chapter-aware.mjs";

export const STRATEGY_FACTORIES = {
  current: () => new BrowserKeyboardStrategy(),
  "chapter-aware": () => new ChapterAwareStrategy()
};

// Default pipeline when config.strategies is omitted: today's behaviour as
// Stage 1, then the chapter-aware fallback.
export const DEFAULT_PIPELINE = [
  { name: "current", maxAttempts: 2 },
  { name: "chapter-aware", maxAttempts: 1 }
];

// Resolve config.strategies into an ordered [{ strategy, maxAttempts }] list,
// dropping disabled/invalid/unknown entries with a warning. null/undefined →
// the default pipeline. maxAttempts:0 (or enabled:false) disables an entry.
export function resolveStrategies(config, logger, factories = STRATEGY_FACTORIES) {
  const specs = Array.isArray(config?.strategies) ? config.strategies : DEFAULT_PIPELINE;
  const resolved = [];
  for (const spec of specs) {
    if (!spec || typeof spec.name !== "string") {
      logger?.warn?.(`ignoring invalid strategy entry: ${JSON.stringify(spec)}`);
      continue;
    }
    if (spec.enabled === false) continue;
    const factory = factories[spec.name];
    if (!factory) {
      logger?.warn?.(`unknown strategy "${spec.name}" — skipping`);
      continue;
    }
    const strategy = factory();
    const maxAttempts = Number.isInteger(spec.maxAttempts) ? spec.maxAttempts : (strategy.defaultMaxAttempts ?? 1);
    if (maxAttempts < 1) continue; // 0 disables, same as enabled:false
    resolved.push({ strategy, maxAttempts });
  }
  return resolved;
}
```

- [ ] **Step 4: Add the config default.** In `src/config.mjs`, add to the `DEFAULTS` object (in the navigation/pacing area is fine) the line:

```js
  // ordered scraping strategy pipeline; null = default (current → chapter-aware)
  strategies: null,
```

The existing `buildConfig` file-layer loop already copies a `strategies` array from the config file (it only skips `null`/`undefined`), so no other `config.mjs` change is needed.

- [ ] **Step 5: Add a config test.** Append to `test/config.test.mjs` (create the file with this content if it does not exist):

```js
// test/config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildConfig } from "../src/config.mjs";

test("strategies: defaults to null (→ default pipeline) when unset", () => {
  const cfg = buildConfig({ _: ["https://x/read"] }, {});
  assert.equal(cfg.strategies, null);
});

test("strategies: a config-file array is carried through verbatim", () => {
  const arr = [{ name: "current", maxAttempts: 2 }, { name: "chapter-aware", enabled: false }];
  const cfg = buildConfig({ _: ["https://x/read"] }, { strategies: arr });
  assert.deepEqual(cfg.strategies, arr);
});
```

> Note: if `test/config.test.mjs` already exists, add only the two `test(...)` blocks and reuse its existing imports.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/registry.test.mjs test/config.test.mjs`
Expected: PASS (registry: 6 tests; config: existing + 2 new).

- [ ] **Step 7: Commit**

```bash
git add src/strategies/registry.mjs src/config.mjs test/registry.test.mjs test/config.test.mjs
git commit -m "feat: strategy registry + strategies config key

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Wire the orchestrator into `scrapeJob` and `BatchRunner`

**Files:**
- Modify: `src/pipeline.mjs` (imports; `scrapeJob` acquire phase; `BatchRunner` builds + injects the orchestrator)
- Modify: `scraper.config.example.json` (document the `strategies` block)
- Test: extend `test/pipeline.test.mjs`

**Interfaces:**
- Consumes: `ScrapingOrchestrator` (Task 4), `resolveStrategies` (Task 6), `validate` (Task 3).
- Produces: `scrapeJob(session, job, config, processor, packagers, uploader, logger, orchestrator)` — new trailing `orchestrator` param; returns the existing shape plus `usedStrategy` and `attempts`.

- [ ] **Step 1: Write the failing tests** (append to `test/pipeline.test.mjs`)

```js
import { scrapeJob } from "../src/pipeline.mjs";

test("scrapeJob: on orchestrator success, packages and returns complete", async () => {
  const calls = { write: 0 };
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const packagers = [{ write: async () => { calls.write++; } }];
  const orchestrator = { run: async () => ({ status: "success", usedStrategy: "current", downloaded: 3, total: 3, attempts: [] }) };
  const r = await scrapeJob({}, { url: "https://x/read", name: "n" }, config, processor, packagers, null, noopLogger, orchestrator);
  assert.equal(r.complete, true);
  assert.equal(r.usedStrategy, "current");
  assert.equal(calls.write, 1);
});

test("scrapeJob: on orchestrator failure, returns incomplete and does not package", async () => {
  const calls = { process: 0 };
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => { calls.process++; return []; } };
  const orchestrator = { run: async () => ({ status: "failed", usedStrategy: null, downloaded: 39, total: 40, attempts: [{ name: "current", attempt: 1, status: "incomplete" }] }) };
  const r = await scrapeJob({}, { url: "https://x/read" }, config, processor, [], null, noopLogger, orchestrator);
  assert.equal(r.complete, false);
  assert.equal(r.saved, 39);
  assert.equal(calls.process, 0, "no packaging on failure");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/pipeline.test.mjs`
Expected: FAIL — `scrapeJob` does not accept/return the new orchestrator-driven shape yet (or `ReferenceError`).

- [ ] **Step 3: Update `src/pipeline.mjs` imports.** At the top, remove now-unused imports (`openReader`, `ReaderDriver`, `missingPages`, `formatPageList`) and add:

```js
import { ScrapingOrchestrator } from "./orchestrator.mjs";
import { resolveStrategies } from "./strategies/registry.mjs";
import { validate } from "./result-validator.mjs";
```

Keep: `ImageCapture`, `BandwidthMeter`/`formatBandwidth`, `PageCache`, `resolveTargets`, `createJobSource`, `DriveUploader`, `buildPackagers`, `ImageProcessor`, `sleep`/`withJitter`, `rm`/`existsSync`. Since the rewritten `scrapeJob` (Step 4) no longer calls `decideOutcome`, simplify the Task 2 lines to a bare re-export so there is no unused import: `export { decideOutcome } from "./outcome.mjs";` (the validator now owns completeness; this re-export only preserves the public symbol for `test/pipeline.test.mjs`).

- [ ] **Step 4: Replace the body of `scrapeJob`** with the orchestrator-driven version (packaging/upload/cleanup unchanged from today):

```js
export async function scrapeJob(session, job, config, processor, packagers, uploader, logger, orchestrator) {
  const targets = resolveTargets(config, job);
  if (config.clearCache) await clearJobCache(targets.cacheDir, logger);
  const cache = config.cache ? await PageCache.open(targets.cacheDir) : null;
  const capture = new ImageCapture(config, logger, cache);
  const meter = new BandwidthMeter({ skip: (url) => capture.wasServedFromCache(url) });
  const seeded = cache ? await capture.seedFromCache() : 0;
  if (seeded) logger.info(`resuming: ${seeded} page(s) already cached — only missing pages will download`);

  try {
    // Acquire phase: the orchestrator runs each configured strategy in order,
    // retrying a strategy for transient failures and falling back to the next.
    // All strategies share `capture` (and its PageCache), so a fallback only
    // fetches what earlier stages missed.
    const r = await orchestrator.run({ session, job, config, capture, meter, seeded });
    if (cache && r.total) { cache.total = r.total; await cache.saveIndex().catch(() => {}); }

    if (r.status !== "success") {
      if ((r.downloaded ?? capture.size) === 0) {
        logger.error("No images captured. Try --headed to watch, or set --count-selector / --advance-key / --host.");
      }
      return { saved: r.downloaded ?? capture.size, total: r.total, complete: false,
               bytes: meter.bytes, requests: meter.count, usedStrategy: r.usedStrategy, attempts: r.attempts };
    }

    // Convert & package (unchanged).
    logger.step("→ converting & packaging");
    const outputs = await processor.process(capture.list());
    for (const packager of packagers) await packager.write(outputs, targets);

    // Upload to Drive; a failed upload → retry, keep local files (unchanged).
    let uploaded = false;
    if (uploader) {
      const uploadCbz = config.cbz && config.driveOnly !== "pdf";
      const uploadPdf = config.pdf && config.driveOnly !== "cbz";
      if (!uploadCbz && !uploadPdf) {
        logger.warn(`--drive had nothing to upload (need ${config.driveOnly || "--cbz or --pdf"} output).`);
      } else {
        logger.step("→ uploading to Drive");
        try {
          if (uploadCbz) await uploader.uploadFile(targets.cbzPath);
          if (uploadPdf) await uploader.uploadFile(targets.pdfPath);
          uploaded = true;
        } catch (e) {
          logger.error(`Drive upload failed: ${e?.message || e}`);
          return { saved: outputs.length, total: r.total, complete: false, bytes: meter.bytes, requests: meter.count, usedStrategy: r.usedStrategy, attempts: r.attempts };
        }
      }
    }

    // Clean up local files only when there is a safe copy elsewhere (unchanged).
    if (config.cleanup) {
      if (uploaded) { logger.step("→ cleaning up local files"); await removeJobArtifacts(targets, logger); }
      else if (!uploader) logger.warn("cleanup skipped: no --drive, refusing to delete the only local copy");
    }

    if (cache) await cache.clear().catch(() => {});
    return { saved: outputs.length, total: r.total, complete: true, bytes: meter.bytes, requests: meter.count, usedStrategy: r.usedStrategy, attempts: r.attempts };
  } finally {
    logger.info(`bandwidth: ${meter.summary(config.costPerGb)}`);
  }
}
```

- [ ] **Step 5: Build + inject the orchestrator in `BatchRunner`.** In the constructor, add injectable seams next to `this._scrapeJob`:

```js
    this._scrapeJob = deps.scrapeJob || scrapeJob;
    this._resolveStrategies = deps.resolveStrategies || resolveStrategies;
    this._validate = deps.validate || validate;
```

In `run()`, after `packagers` are built and before launching the browser, add:

```js
    const strategies = this._resolveStrategies(this.config, this.logger);
    if (!strategies.length) {
      this.logger.error("no scraping strategies enabled — check the `strategies` config.");
      return 1;
    }
    const orchestrator = new ScrapingOrchestrator(strategies, this._validate, this.logger);
```

Then pass `orchestrator` into `_runJobs`:

```js
      results = await this._runJobs({ jobs, source, session, processor, packagers, uploader, orchestrator });
```

- [ ] **Step 6: Thread `orchestrator` through `_runJobs`.** Change the method signature to destructure `orchestrator`, and update the `_scrapeJob` call:

```js
  async _runJobs({ jobs, source, session, processor, packagers, uploader, orchestrator }) {
    // ... unchanged loop ...
        const r = await this._scrapeJob(session, job, this.config, processor, packagers, uploader, this.logger, orchestrator);
    // ... unchanged ...
  }
```

- [ ] **Step 7: Document the config block.** In `scraper.config.example.json`, add before the closing `}` (and a comma after the previous entry):

```jsonc
  // --- Scraping strategies (ordered fallback pipeline; omit to use the default) ---
  "strategies": [
    { "name": "current",       "enabled": true, "maxAttempts": 2 },
    { "name": "chapter-aware", "enabled": true, "maxAttempts": 1 }
  ]
```

- [ ] **Step 8: Run the pipeline tests + the whole suite**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — the two new `scrapeJob` tests plus all existing `_runJobs`/`decideOutcome`/`describeDryRun` tests (the existing `_runJobs` tests pass `orchestrator: undefined`, which their injected `_scrapeJob` ignores).

Run: `npm test`
Expected: PASS — every test file green.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline.mjs scraper.config.example.json test/pipeline.test.mjs
git commit -m "feat: run the strategy pipeline via the orchestrator in scrapeJob/BatchRunner

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: README documentation

**Files:**
- Modify: `README.md` (document the strategy pipeline, the `strategies` config, and the fallback behaviour)

**Interfaces:**
- Consumes: nothing (docs only).
- Produces: nothing.

- [ ] **Step 1: Add a "Scraping strategies" section to `README.md`.** Cover, in the README's existing voice:
  - The pipeline concept: strategies run in order; a strategy retries itself for transient failures (`maxAttempts`), then the orchestrator falls back to the next strategy.
  - The two built-in strategies: `current` (the original headless keyboard-advance reader) and `chapter-aware` (recovers readers that auto-jump to the next chapter past the last page, e.g. batcave.biz).
  - The `strategies` config array (name / enabled / maxAttempts), that omitting it uses the default `current → chapter-aware`, and that `"strategies": [{ "name": "current" }]` restores single-strategy behaviour.
  - How to add a strategy: create `src/strategies/<name>.mjs` implementing `{ name, defaultMaxAttempts, execute(ctx) }` and register it in `src/strategies/registry.mjs`.
  - A note that attempt tracking is within a single run; page-level resume across runs is unchanged (the `PageCache`).

- [ ] **Step 2: Verify the docs match the shipped config** by re-reading the `strategies` block in `scraper.config.example.json` and confirming names/keys match the README text.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document the multi-stage scraping strategy pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full suite:** `npm test` → all files PASS.
- [ ] **Smoke-test backward compatibility (dry run, no browser):**
  `node scrape.mjs https://batcave.biz/event/ultimate-marvel/394 --dry-run`
  Expected: the dry-run preview prints as before and exits 0 (dry-run returns before any orchestrator/browser work).
- [ ] **Confirm the default pipeline resolves** by running the app against a real target (optional, needs network): the log should show `[1/2] strategy=current …` and, on a batcave last-page case, fall through to `[2/2] strategy=chapter-aware …` and complete.
