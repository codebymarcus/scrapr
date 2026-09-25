# Multi-Stage / Fallback Scraping Strategies — Design

**Date:** 2026-09-25
**Status:** Draft for review
**Author:** Mark Aquiatin (with Claude)

---

## 1. Purpose & Intent

Today the scraper runs a **single** way to obtain a chapter's pages: open the
reader past its JS gate ([`navigation.mjs`](../../../src/navigation.mjs)), then
press `ArrowRight` through a virtualized reader
([`reader.mjs`](../../../src/reader.mjs)) while
[`capture.mjs`](../../../src/capture.mjs) passively collects image responses.

When that fails or comes up short, the job is marked `status="retry"` in the
sheet ([`sources.mjs`](../../../src/sources.mjs)) and the next run **re-runs the
exact same approach** — so a job that fails for a structural reason fails the
same way forever.

**Goal:** introduce a pluggable **multi-stage scraping pipeline**. Strategies are
attempted in order; a strategy may retry itself a bounded number of times, and
when it is exhausted the orchestrator **falls back to a different strategy**
instead of repeating the known failure. The existing flow becomes Stage 1; a
second, genuinely different strategy provides real recovery.

### The motivating real failure (batcave.biz)

On `batcave.biz` chapter readers (e.g. `https://batcave.biz/event/ultimate-marvel/395`):

1. `ReaderDriver.detectTotal()` counts, say, **40** pages up front.
2. Near the end, pressing `ArrowRight` on the last page triggers **client-side
   navigation to the *next* event URL** (a sibling issue).
3. `ImageCapture` is locked to the original chapter's `issueDir`, so it correctly
   ignores the next chapter's images — but the reader has **navigated away before
   the true last page rendered**.
4. Result: `39/40` → `incomplete` → `status="retry"` → the next run repeats step
   1–3 → **fails forever.**

This is the canonical "retry doesn't change the approach" bug and is the concrete
target for the fallback strategy (Stage 2).

### Agreed context (from brainstorming)

| Question | Decision |
|---|---|
| What are the real strategies? | Build the full orchestration **framework**; wrap the current flow as **Stage 1**; add **one genuine Stage 2** (a *chapter-aware* reader) whose motivating example is the batcave last-page jump. Extra strategies become trivial to add. |
| Attempt / progress tracking scope | **Within one CLI run.** Page-level resume still persists via the existing `PageCache`. Sheet `status` stays `blank/retry/done/skip` — no schema change. |
| Where to configure the pipeline | **Extend the existing JSON config** (`scraper.config.json`) with an ordered `strategies` array, via the existing layered config system. |

### Non-goals (this feature)

- No HTTP service, API layer, database, queue, or distributed workers.
- No cross-invocation persistence of *which strategies were attempted* (within
  one run only).
- No failure-classification-driven strategy **selection** (goal 13) — the
  architecture leaves a clean seam for it (`isRetryable`, `FailureCode`) but does
  not implement it.
- No per-strategy `headed`/browser-relaunch override (see §9, deferred). Stage 2's
  distinguishing behavior is all page-level and needs no relaunch.
- No change to image processing, packaging, Drive upload, or naming.

---

## 2. What the current code already gives us

Grounding the generic spec in the actual project:

| Concern | Where it lives today | Reuse |
|---|---|---|
| Entry / batch loop | `scrape.mjs` → `BatchRunner.run()` → `_runJobs()` | Unchanged |
| One job, end to end | `scrapeJob()` in `pipeline.mjs` | **Refactored** to call the orchestrator for the acquire phase |
| "How to obtain images" | `openReader()` + `ReaderDriver.run()` | Wrapped as **Stage 1** |
| Image collection + rate-limit backoff | `ImageCapture` | **Shared** across strategies |
| Partial-result resume ("Option B") | `PageCache` (`.scaper-cache/<job>/`) | **Shared** — Stage 2 fetches only what Stage 1 missed |
| Complete / incomplete / stagnant | `decideOutcome()` + `missingPages()` | Moved behind the **validator** |
| Failed / done persistence | `SheetSource.setStatus()` (`status` column) | Unchanged |
| Config layering | `DEFAULTS` < JSON file < CLI (`config.mjs`) | **Extended** with `strategies` |
| Logging / progress | `createLogger()` | Reused for stage output |
| Tests | `node --test`, one file per module, DI (`runner._scrapeJob`, `noopLogger`) | Same pattern |

**Key insight:** the strategy boundary is the **acquire phase only** (open +
drive → images land in the shared `ImageCapture`/`PageCache`). Everything after
acquisition — validation, packaging, upload, cleanup, cache lifecycle — is
strategy-agnostic and stays in `scrapeJob`.

---

## 3. Architecture

```
                       scrapeJob (pipeline.mjs)
                              │
             build shared capture / cache / meter
                              │
                              ▼
                   ScrapingOrchestrator.run()
                              │
                 ┌────────────┴────────────┐
                 │      StrategyRegistry     │  (config → ordered, enabled strategies)
                 └────────────┬────────────┘
        ┌──────────────┬──────┴───────┬───────────────┐
        ▼              ▼              ▼                ▼
   Stage 1        (retry ≤ N)     Stage 2         Stage N…
  "current"    same strategy,   "chapter-aware"  (future files)
 (browser-      retryable        end-of-chapter
  keyboard)     failures only    jump detection
        │              │              │
        └──────────────┴──────────────┘
                       │ each attempt → ScrapingResult
                       ▼
                ResultValidator  (decideOutcome + missingPages)
                       │
             ┌─────────┴─────────┐
          success            incomplete / failed
             │                     │
             ▼            retry same, else fall back
     return report ◄─── all strategies exhausted → FAILED report
             │
             ▼
   scrapeJob resumes: package → upload → cleanup   (UNCHANGED)
```

Responsibility separation (as the spec asks):

- **Strategy** = *how* to scrape.
- **Validator** = *whether* the result is valid.
- **Orchestrator** = *which* strategy runs next (retry vs. fallback).
- **State** = *what* already happened — `PageCache` (pages, cross-run) +
  in-memory attempt log (strategies, this run).
- **CLI/logger** = *how* progress is presented.

---

## 4. New & changed files

```
src/
  strategies/
    strategy.mjs          NEW  contract, ScrapingResult, FailureCode, isRetryable
    registry.mjs          NEW  name → factory; resolve(config) → ordered strategies
    browser-keyboard.mjs  NEW  Stage 1: wraps openReader + ReaderDriver ("current")
    chapter-aware.mjs     NEW  Stage 2: jump-aware reader ("chapter-aware")
  result-validator.mjs    NEW  validate(capture, total, …) → {status, missing, …}
  orchestrator.mjs        NEW  ScrapingOrchestrator: run strategies, retry/fallback, report
  pipeline.mjs            EDIT scrapeJob calls the orchestrator for the acquire phase
  config.mjs              EDIT parse + default the `strategies` array
scraper.config.example.json  EDIT document the `strategies` block
test/
  strategy.test.mjs       NEW  ScrapingResult helpers, isRetryable
  registry.test.mjs       NEW  ordering, enabled filter, unknown-name handling
  result-validator.test.mjs NEW success / incomplete / empty
  orchestrator.test.mjs   NEW  the fallback matrix (§10)
```

Nothing else is touched.

---

## 5. The strategy contract (`src/strategies/strategy.mjs`)

```js
// A scraping strategy is one *way* to acquire a chapter's pages into the shared
// ImageCapture. The orchestrator never inspects a strategy's internals.
//
// interface ScrapingStrategy {
//   name: string                       // matches the config `name`
//   defaultMaxAttempts?: number        // fallback when config omits maxAttempts
//   execute(context) => Promise<ScrapingResult>
// }
//
// ScrapingContext = {
//   session,   // BrowserSession — the strategy opens its OWN fresh page
//   job,       // { url, name, status, row }
//   config,    // full resolved config
//   capture,   // SHARED ImageCapture (accumulates across strategies)
//   meter,     // SHARED BandwidthMeter
//   logger,
// }

export const FailureCode = Object.freeze({
  TIMEOUT: "TIMEOUT",
  NETWORK_ERROR: "NETWORK_ERROR",
  HTTP_ERROR: "HTTP_ERROR",
  BLOCKED: "BLOCKED",
  RATE_LIMITED: "RATE_LIMITED",
  EMPTY_RESULT: "EMPTY_RESULT",
  INCOMPLETE_RESULT: "INCOMPLETE_RESULT",
  NAVIGATION_JUMP: "NAVIGATION_JUMP",   // the batcave last-page jump
  PARSER_ERROR: "PARSER_ERROR",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
});

// ScrapingResult:
//   { status: "success" | "incomplete" | "failed",
//     data?:   { downloaded, total },       // counts for the run
//     error?:  { code: FailureCode, message },
//     metadata?: Record<string, unknown> }  // e.g. { durationMs, newPages }

export const ok       = (data, metadata) => ({ status: "success", data, metadata });
export const partial  = (data, code, message, metadata) =>
  ({ status: "incomplete", data, error: { code, message }, metadata });
export const failed   = (code, message, metadata) =>
  ({ status: "failed", error: { code, message }, metadata });

// Retryable failures justify re-running the SAME strategy; the rest fall through
// to the next strategy immediately. Structural failures are not retryable.
const RETRYABLE = new Set([
  FailureCode.TIMEOUT, FailureCode.NETWORK_ERROR,
  FailureCode.HTTP_ERROR, FailureCode.RATE_LIMITED,
]);
export const isRetryable = (code) => RETRYABLE.has(code);
```

Rationale: `incomplete` (e.g. `39/40`) is **not** a same-strategy retry — the
same driver produced the shortfall — so it triggers **fallback**, not retry.
`INCOMPLETE_RESULT` and `NAVIGATION_JUMP` are therefore not in `RETRYABLE`.

---

## 6. Stage 1 — `browser-keyboard.mjs` ("current")

A thin wrapper that reproduces today's behavior **exactly**, so the success path
is byte-for-byte unchanged.

```js
export class BrowserKeyboardStrategy {
  name = "current";
  defaultMaxAttempts = 2;

  async execute({ session, job, config, capture, meter, logger }) {
    const page = await session.newPage();
    try {
      await capture.attach(page);
      meter.attach(page);
      const seeded = capture.size;
      await openReader(page, job.url, config, logger);
      const { total } = await new ReaderDriver(page, capture, config, logger).run();
      const downloaded = capture.size;
      return classify({ downloaded, total, seeded, config }); // → ok/partial/failed
    } catch (e) {
      return failed(mapError(e), e?.message);   // TIMEOUT/NETWORK_ERROR/…
    } finally {
      await page.close().catch(() => {});
    }
  }
}
```

- `classify()` reuses `decideOutcome()`/`missingPages()` via the **validator**
  (§8) — the strategy does not re-implement completeness logic.
- `mapError()` maps Playwright errors to a `FailureCode` (timeout → `TIMEOUT`,
  `net::` → `NETWORK_ERROR`, otherwise `UNKNOWN_ERROR`).
- The **shared** capture means each attempt re-attaches to a fresh page but keeps
  accumulating into the same image map + `PageCache`.

---

## 7. Stage 2 — `chapter-aware.mjs` ("chapter-aware")

The real fallback. Same capture substrate, but it drives the reader defensively
so the last page is captured instead of being lost to the sibling-issue jump.

Distinguishing behavior (all page-level — no browser relaunch):

1. **Longer settle** near the end (derived from `config.settle`, e.g. ×2) so the
   final page's image loads before the site auto-advances.
2. **Jump detection:** capture the reader's own document URL after `openReader`.
   Before/after each advance, compare `page.url()`. If it changes to a **different
   issue path** (differs from the opening URL's chapter segment), the strategy:
   - treats it as **end-of-chapter reached**, not a failure to press further;
   - **navigates back** to the reader URL, waits for the last page image, and
     captures it;
   - stops advancing.
3. If, after that, the count still matches the *originally over-detected* total
   minus the phantom trailing page, it accepts the real last page as the end
   (i.e. it trusts "no more pages in this issueDir" over the up-front count).

Returns `ok({downloaded, total})` when the true last page is captured, else
`partial(..., INCOMPLETE_RESULT)` or `failed(NAVIGATION_JUMP, …)` if it cannot
recover — which, being the last configured strategy, becomes the final result.

> Implementation note for the plan: the URL-diffing helper (`sameIssue(a, b)`)
> and the "advance one, watch the URL" loop are the only genuinely new logic;
> everything else reuses `ImageCapture`, `sleep/withJitter`, and `navigateWithRetry`.

---

## 8. Validator (`src/result-validator.mjs`)

Pulls completeness judgment out of the strategies so all strategies are judged
identically.

```js
import { decideOutcome } from "./pipeline.mjs";      // reused, not duplicated
import { missingPages } from "./processor.mjs";

// validate({ capture, total, seeded, config }) →
//   { status: "success"|"incomplete"|"failed", downloaded, total, missing, stagnant }
export function validate({ downloaded, total, seeded, images, acceptPartial }) {
  if (downloaded === 0) return { status: "failed", code: "EMPTY_RESULT", downloaded, total, missing: [] };
  const o = decideOutcome({ downloaded, total, seeded, acceptPartial });
  const missing = missingPages(images, total);
  if (o.complete) return { status: "success", downloaded, total, missing: [] };
  return { status: "incomplete", code: "INCOMPLETE_RESULT", downloaded, total, missing, stagnant: o.stagnant };
}
```

`decideOutcome`/`missingPages` keep their current homes and tests; the validator
composes them. (If circular-import friction appears, `decideOutcome` moves to a
tiny `outcome.mjs` that both `pipeline.mjs` and the validator import — decided at
plan time.)

---

## 9. Orchestrator (`src/orchestrator.mjs`)

```js
export class ScrapingOrchestrator {
  // `validate` is the function from result-validator.mjs (§8), injected so the
  // orchestrator can be unit-tested with a stub validator.
  constructor(strategies, validate, logger, { attemptsFor } = {}) { … }

  // ctx = { session, job, config, capture, meter, seeded }
  // → { status, usedStrategy, downloaded, total, attempts: [ {name, attempt, status, code, durationMs} ] }
  async run(ctx) {
    const log = [];
    const N = this.strategies.length;
    for (let s = 0; s < N; s++) {
      const strat = this.strategies[s];
      const max = this.attemptsFor(strat);          // config maxAttempts ?? strat.defaultMaxAttempts ?? 1
      for (let attempt = 1; attempt <= max; attempt++) {
        this.logger.info(`[${s + 1}/${N}] strategy=${strat.name} attempt ${attempt}/${max}`);
        const t0 = Date.now();
        const res = await strat.execute(ctx);
        const v = this.validate({ ...res.data, seeded: ctx.seeded, images: ctx.capture.list(), acceptPartial: ctx.config.acceptPartial });
        log.push({ name: strat.name, attempt, status: v.status, code: res.error?.code, durationMs: Date.now() - t0 });
        this.logger.info(`      → ${v.status.toUpperCase()} (${v.downloaded}/${v.total || "?"})`);

        if (v.status === "success") {
          this.logger.success(`✓ completed using strategy: ${strat.name}`);
          return { status: "success", usedStrategy: strat.name, downloaded: v.downloaded, total: v.total, attempts: log };
        }
        // retry the SAME strategy only for retryable transport failures
        if (res.status === "failed" && isRetryable(res.error?.code) && attempt < max) continue;
        break; // otherwise stop retrying this strategy → fall back to the next
      }
    }
    this._reportFailure(log);                        // the failure table (§11)
    return { status: "failed", usedStrategy: null, attempts: log, /* counts from last */ };
  }
}
```

Guarantees mapped to acceptance criteria:

- **Deterministic order** — `strategies` array order.
- **Valid result stops the pipeline** — early `return` on success.
- **Retry ≠ fallback** — inner loop = retry (retryable failures only); outer loop
  = fallback.
- **No repeating a known failure** — once a strategy breaks its inner loop it is
  never revisited this run; `incomplete` never retries the same strategy.
- **Records every attempt** — `attempts` log → summary + failure table.

> **Deferred:** a per-strategy `headed` override would need relaunching the
> browser (it's a launch-time option). Out of scope; noted as future work.

---

## 10. Wiring into `pipeline.mjs`

`scrapeJob` changes only in its middle. Before/after are untouched:

```js
export async function scrapeJob(session, job, config, processor, packagers, uploader, logger, orchestrator) {
  const targets = resolveTargets(config, job);
  if (config.clearCache) await clearJobCache(targets.cacheDir, logger);
  const cache = config.cache ? await PageCache.open(targets.cacheDir) : null;
  const capture = new ImageCapture(config, logger, cache);
  const meter = new BandwidthMeter({ skip: (u) => capture.wasServedFromCache(u) });
  const seeded = cache ? await capture.seedFromCache() : 0;

  // --- acquire phase, now via the orchestrator (replaces inline open+drive) ---
  const r = await orchestrator.run({ session, job, config, capture, meter, seeded });
  if (r.status !== "success") {
    return { saved: r.downloaded ?? capture.size, total: r.total, complete: false,
             bytes: meter.bytes, requests: meter.count, attempts: r.attempts };
  }

  // --- package → upload → cleanup: UNCHANGED from today ---
  const outputs = await processor.process(capture.list());
  …
}
```

`BatchRunner` builds the orchestrator once (from `StrategyRegistry.resolve(config)`
+ the validator) and injects it, mirroring how `processor`/`packagers`/`uploader`
are built once in `run()`. `BatchRunner`'s injectable `_scrapeJob` seam stays, so
existing `_runJobs` tests keep working; a new `attempts` field on the result feeds
the batch summary.

---

## 11. Config (`config.mjs` + example)

New key in `DEFAULTS`:

```js
strategies: null,   // null → default pipeline (below); or an ordered array
```

Resolution (`StrategyRegistry.resolve(config)`):

- `config.strategies == null` → **default** =
  `[{ name: "current", maxAttempts: 2 }, { name: "chapter-aware", maxAttempts: 1 }]`.
- Otherwise use the array as given (order preserved), dropping `enabled: false`
  entries and warning on unknown names.
- Each entry: `{ name, enabled = true, maxAttempts = strategy.defaultMaxAttempts }`.

Example (`scraper.config.example.json`):

```jsonc
// --- Scraping strategies (ordered pipeline; omit to use the default) ---
"strategies": [
  { "name": "current",       "enabled": true, "maxAttempts": 2 },
  { "name": "chapter-aware", "enabled": true, "maxAttempts": 1 }
],
```

**Backward compatibility:** because the key defaults to the two-stage pipeline and
**fallback only fires when Stage 1 fails/incomplete**, every job that succeeds
today succeeds identically. To restore strict single-strategy behavior:
`"strategies": [{ "name": "current" }]`.

---

## 12. CLI output

Per-job, in the existing logger style:

```
[1/2] strategy=current        attempt 1/2
      → INCOMPLETE (39/40)
[2/2] strategy=chapter-aware  attempt 1/1
      → SUCCESS (40/40)
✓ completed using strategy: chapter-aware
```

Final failure (all strategies exhausted):

```
✗ failed: https://batcave.biz/event/ultimate-marvel/395
  strategies attempted:
    1. current        → INCOMPLETE (39/40)
    2. chapter-aware  → NAVIGATION_JUMP
  final status: FAILED
```

The batch summary additionally notes the winning strategy per job where useful.

### Logging (goal 16)

Each attempt logs: target, strategy, stage index, attempt number, result status,
failure code, duration. No credentials/cookies/tokens are logged (unchanged —
the logger never touches them today).

---

## 13. Partial results (spec §14)

**Option B — Resume**, inherited for free: all strategies share one
`ImageCapture` + `PageCache`, so Stage 2 sees Stage 1's pages already captured
and only fetches what's missing. No restart, no merge step. This matches the
existing single-strategy resume behavior and is the least surprising.

---

## 14. Resume behavior (spec §11)

- **Within a run:** the orchestrator advances through strategies; nothing to
  persist beyond the shared `PageCache`.
- **Across runs:** unchanged. A job left `retry` is re-attempted from Stage 1 on
  the next invocation, but the `PageCache` means it resumes at the page level, and
  the *orchestrator* will again fall through to Stage 2 if Stage 1 still can't
  finish. We deliberately do **not** persist "Stage 1 already exhausted" across
  runs (agreed: within-run scope) — the cost is one wasted Stage-1 attempt per
  invocation, which the page cache makes cheap.

This choice is documented here so the behavior is explicit rather than implied.

---

## 15. Testing (spec §19)

`node --test`, fakes injected, **no real browser** — mirroring
`pipeline.test.mjs`. Fake strategies return scripted `ScrapingResult`s.

Orchestrator matrix:

| Scenario | Expect |
|---|---|
| Stage A → success | B not executed |
| A failed → B success | A and B ran; final success |
| A incomplete → B success | B ran (incomplete ≠ retry) |
| A failed(retryable) → A success | A retried, succeeded; B not run |
| A failed(retryable) ×maxAttempts → B success | A retried to limit, then B ran |
| A failed(non-retryable) → B | A **not** retried; B ran immediately |
| A, B, C all fail | final FAILED; every attempt recorded |
| B disabled | B skipped (A → C) |
| unknown strategy name | warned + skipped, pipeline still runs |

Plus:

- `strategy.test.mjs` — `ok/partial/failed` shape; `isRetryable` per code.
- `registry.test.mjs` — default when `null`; order preserved; `enabled:false`
  dropped; `maxAttempts` precedence.
- `result-validator.test.mjs` — success / incomplete / empty (reuses
  `decideOutcome` cases already covered, at the validator boundary).

Existing `pipeline.test.mjs` `_runJobs` tests keep passing (injected `_scrapeJob`
unaffected).

---

## 16. Future extensions (left open, not built)

- **Failure-aware selection (goal 13):** `FailureCode` + `isRetryable` already
  classify failures; a future selector can map `BLOCKED → browser`,
  `TIMEOUT → alternate-network`, etc., by choosing the next strategy from the
  failure instead of pure order.
- **Strategy metadata** (`{ cost, supportedFailures }`) can be added to the
  contract without touching the orchestrator loop.
- **Per-strategy `headed`/relaunch** — needs launch-time browser options;
  deferred.
- **Cross-run attempt persistence** — could encode attempted strategies in the
  sheet or a sidecar if it ever proves worthwhile.

---

## 17. Acceptance criteria (traceability)

- Existing scraper works as Stage 1 → §6.
- Multiple strategies registerable → §5, §11.
- Common interface → §5.
- Add strategy without touching orchestration → new file + one registry line
  (§4, §11).
- Deterministic order → §9.
- Valid result stops pipeline → §9.
- Incomplete triggers fallback → §5 (`incomplete` not retryable), §9.
- Per-strategy retry limits → §9, §11 (`maxAttempts`).
- Retry vs. fallback distinct → §9 (inner vs. outer loop).
- Exhausted strategy not repeated → §9.
- Records attempted strategies → §9 (`attempts` log), §12.
- Useful final-failure info → §12 failure table.
- CLI shows current strategy + result → §12.
- Backward compatible → §11.
- Tests cover orchestration/fallback → §15.
- No HTTP-service architecture → Non-goals §1.
