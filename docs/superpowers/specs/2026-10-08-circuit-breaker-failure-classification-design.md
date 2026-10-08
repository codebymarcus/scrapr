# Circuit Breaker + Failure Classification — Design

**Date:** 2026-10-08
**Status:** Draft for review
**Author:** Mark Aquiatin (with Claude)
**Related:** [site profiles](2026-10-08-site-profiles-design.md) ·
[metadata + auto-naming](2026-10-08-metadata-auto-naming-design.md) ·
[multi-stage strategies](2026-09-25-multi-stage-scraping-strategies-design.md) ·
[roadmap audit](../notes/2026-10-08-roadmap-audit.md)

---

## 1. Purpose & Intent

Today a batch run keeps hitting a domain row after row even when that domain is
clearly unhealthy — rate-limiting, blocking, or timing out — burning metered-proxy
data/cost and risking an IP ban (we observed batcave throttling a run down to
4/29). And when a job fails, the only record is a generic `retry` in the sheet;
*why* it failed (the `FailureCode`) is not surfaced for a human scanning a batch.

**Goal (sub-project #3), scoped to two batch-level capabilities:**

1. **Circuit breaker + adaptive backoff** — track per-domain failures across a
   run; slow a struggling domain (growing delay), and after repeated *hard*
   failures **stop crawling that domain** for the rest of the run, leaving its
   untried rows retryable for a future run. Saves proxy cost and is polite.
2. **Surface failure classification** — record each job's `FailureCode` (and the
   mechanism) in a new sheet `reason` column and an end-of-run report, so a batch
   shows *why* rows failed. The existing `status` column keeps its exact
   semantics.

This is deliberately **batch-level**: the per-job orchestrator, strategies,
validator, and capture are unchanged. It does **not** add failure→mechanism
routing or new recovery mechanisms (those options were considered and set aside).

### Agreed context (from brainstorming)

| Question | Decision |
|---|---|
| Focus | **Circuit breaker + adaptive backoff** and **surface failure classification** (not failure→mechanism routing, not a new recovery mechanism). |
| Breaker action | **Skip the tripped domain's remaining rows this run, left retryable** (status untouched → a future run retries). |
| Surfacing | **New sheet `reason` column + end-of-run report**; the `status` column stays `done`/`retry` (non-breaking). |

### Non-goals (this phase)

- Failure→mechanism selection / mechanism metadata (`supportedFailures`, `cost`).
- New scraping/recovery mechanisms (slow-lane, stealth, HTTP-first).
- Cross-run persistence of breaker state (within one run only).
- A machine-readable JSON report file (console + sheet only).
- Any change to `scrapeJob`, the orchestrator, strategies, validator, or capture.

---

## 2. Architecture

A small, pure **`CircuitBreaker`** ([src/breaker.mjs](../../../src/breaker.mjs),
new) holds per-domain failure state for ONE run. `BatchRunner._runJobs` consults
it and records outcomes; a `failureCodeOf(result)` helper classifies each job; the
sheet gains a managed `reason` column.

```
_runJobs, per job:
  host = hostOf(job.url)
  if breaker.isTripped(host):
    log; push { skipped:true, breakerSkipped:true }; setReason(job, "skipped: domain circuit-breaker"); continue   // status untouched
  wait = itemDelay + breaker.extraDelay(host)         // adaptive backoff
  r = scrape(job)
  code = failureCodeOf(r)                              // null when ok
  breaker.record(host, { ok: r.ok, code })            // trips at threshold
  setStatus(job, r.ok ? "done" : "retry")             // unchanged semantics
  setReason(job, r.ok ? "" : (code || "FAILED"))
```

Best-effort throughout: the breaker never fails a job; `maxDomainFailures:0`
disables it entirely (today's behaviour).

---

## 3. Circuit breaker — `src/breaker.mjs` (new)

```js
import { FailureCode, mapError } from "./strategies/strategy.mjs";

// Only these codes mean "the domain/server is unhealthy" — they count toward the
// breaker and the adaptive backoff. Content failures (INCOMPLETE_RESULT,
// EMPTY_RESULT, NAVIGATION_JUMP, PARSER_ERROR) and UNKNOWN_ERROR do NOT trip it:
// a flaky chapter must not blacklist a healthy domain.
export const DOMAIN_HEALTH_CODES = new Set([
  FailureCode.RATE_LIMITED, FailureCode.BLOCKED, FailureCode.HTTP_ERROR,
  FailureCode.TIMEOUT, FailureCode.NETWORK_ERROR
]);

// The hostname key for a job URL (stable even on a malformed URL).
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return String(url); }
}

// The primary FailureCode of a finished job result, or null when it succeeded.
export function failureCodeOf(result) {
  if (!result || result.ok) return null;
  if (result.error) return mapError(result.error);          // exception path (string)
  const attempts = result.attempts;
  if (Array.isArray(attempts) && attempts.length) return attempts[attempts.length - 1].code || FailureCode.UNKNOWN_ERROR;
  return FailureCode.UNKNOWN_ERROR;
}

export class CircuitBreaker {
  // threshold: consecutive domain-health failures before a host trips (0 = off).
  // base: backoff base ms (defaults to itemDelay); cap: max backoff ms.
  constructor(threshold = 3, { base = 3000, cap = 60000 } = {}) {
    this.threshold = threshold;
    this.base = base;
    this.cap = cap;
    this._fails = new Map();     // host -> consecutive domain-health failures
    this._tripped = new Set();   // hosts that have tripped this run
    this.skippedCount = 0;       // rows skipped because their host was tripped
  }

  enabled() { return this.threshold > 0; }

  // Record a job's outcome for its host.
  record(host, { ok, code } = {}) {
    if (!this.enabled()) return;
    if (ok) { this._fails.set(host, 0); return; }            // success resets
    if (!DOMAIN_HEALTH_CODES.has(code)) return;              // content failures: no change
    const n = (this._fails.get(host) || 0) + 1;
    this._fails.set(host, n);
    if (n >= this.threshold) this._tripped.add(host);
  }

  isTripped(host) { return this.enabled() && this._tripped.has(host); }

  // Escalating extra delay (ms) before this host's next job; 0 when healthy.
  extraDelay(host) {
    if (!this.enabled()) return 0;
    const n = this._fails.get(host) || 0;
    if (n <= 0) return 0;
    return Math.min(this.cap, this.base * 2 ** (n - 1));
  }

  // One-shot accounting when a tripped host's row is skipped.
  noteSkip() { this.skippedCount++; }

  trippedHosts() { return [...this._tripped]; }
}
```

- `failureCodeOf` reuses `mapError` for the exception path (a caught throw stored
  as `result.error` string) and otherwise trusts the orchestrator's recorded
  `attempts[].code`.
- The backoff and the trip share the same per-host counter: a host that fails
  domain-health checks is first slowed (growing `extraDelay`), then skipped once
  the counter reaches `threshold`.

---

## 4. Config — `src/config.mjs`

Add to `DEFAULTS`:
```js
  // Circuit breaker: after this many consecutive domain-health failures
  // (rate-limit/block/timeout/network/http) on one host in a run, stop crawling
  // that host (its untried rows stay retryable) and grow the delay before then.
  // 0 disables the breaker and the adaptive backoff.
  maxDomainFailures: 3,
```
CLI: `--max-domain-failures <n>` (parsed like other numeric flags, `Math.max(0, …)`).
Document in `scraper.config.example.json`.

---

## 5. Sheet `reason` column — `src/sources.mjs`

`SheetSource` manages a second column, `reason`, exactly like `status`:
- On `load()`, find a header among `reason`/`error`/`note`; if absent, append a
  new `reason` column (grow the range) — mirroring the existing status-column
  creation. Store `this._reasonCol`.
- `setReason(job, text)`: write `text` to the job's row in the reason column and
  persist (same write-back path as `setStatus`, with the same "is it open in
  Excel?" warning on failure). A no-op when `!hasStatus` or `job.row < 0`.
- `UrlSource.setReason()` is a no-op (single-URL has no sheet).

The `status` column is untouched, so `skipReason` and resume behave exactly as
today. `reason` is advisory metadata only (never read back for control flow).

> Headerless sheets (no `url` header) have no status tracking today and keep none
> — `setReason` is a no-op there, same as `setStatus`.

---

## 6. Batch loop wiring — `src/pipeline.mjs`

- `run()`: build one breaker — `const breaker = new CircuitBreaker(this.config.maxDomainFailures, { base: this.config.itemDelay || 3000 });` — and pass it into `_runJobs` (alongside the existing params). Injectable for tests via a `deps.breaker` or by constructing from config (default path).
- `_runJobs`, per job (after the existing `skipReason` status check):
  1. `const host = hostOf(job.url);`
  2. If `breaker.isTripped(host)`: `logger.warn(...)`; `breaker.noteSkip()`;
     `results.push({ ...job, skipped: true, breakerSkipped: true })`;
     `source.setReason(job, "skipped: domain circuit-breaker")`; `continue`
     (NO `setStatus` → the row stays blank/`retry`).
  3. Pre-job wait: `const extra = breaker.extraDelay(host); const waitMs = (scrapedAny ? this.config.itemDelay : 0) + extra;` then `if (waitMs > 0) await sleep(withJitter(waitMs, this.config.jitter));` (replaces the current itemDelay-only wait). If `extra > 0`, log a one-line "backing off <host> <ms>".
  4. Scrape as today → `r` (or the catch path).
  5. `const code = failureCodeOf(resultObj);` where `resultObj` is the pushed result (`{ ...job, ...r, ok }` or the error result). `breaker.record(host, { ok: complete, code });`
  6. `if (source.hasStatus) { source.setStatus(job, complete ? "done" : "retry"); source.setReason(job, complete ? "" : (code || "FAILED")); }`
- `_summary`: unchanged counts, plus (a) each failed row shows its `code`/mechanism, and (b) a line per tripped host with its skipped-row count.

The `scrapedAny` gating stays so the first job has no leading delay. When
`maxDomainFailures:0`, `isTripped` is always false and `extraDelay` is always 0 —
byte-for-byte today's behaviour.

---

## 7. End-of-run report — `_summary`

Enhance the existing failed-jobs block:
```
marked retry:
  - https://batcave.biz/event/ultimate-marvel/395  (RATE_LIMITED, chapter-aware)
  - https://other/x  (INCOMPLETE_RESULT, current, 37/40)
circuit breaker tripped:
  - batcave.biz: 3 consecutive failures → 5 row(s) skipped this run (left to retry)
```
Single-URL mode: on failure, one line with the code. The per-failed-job code
comes from `failureCodeOf`; the mechanism from `r.usedStrategy` (success) or the
last attempt's `name`.

---

## 8. Error handling / edge cases

- Breaker is best-effort: it never throws into the job loop; a bad URL yields a
  stable `hostOf` key; a `setReason` write failure warns and continues (like
  `setStatus`).
- Content failures (`INCOMPLETE_RESULT`, `EMPTY_RESULT`, `NAVIGATION_JUMP`,
  `PARSER_ERROR`, `UNKNOWN_ERROR`) never trip the breaker or add backoff, so a
  flaky chapter can't blacklist a healthy domain.
- A single-URL run has one host and no sheet; the breaker still applies (it just
  can't skip "remaining rows" because there are none) and `setReason` is a no-op.
- `maxDomainFailures:0` fully disables breaker + adaptive backoff.

---

## 9. Testing

`node --test`, fakes, no real browser.

New — `test/breaker.test.mjs`:
- `hostOf`: normal URL → hostname; bad URL → the raw string; case-folding.
- `failureCodeOf`: ok → null; `{error:"net::ERR"}` → NETWORK_ERROR (via mapError);
  attempts list → last code; empty/absent → UNKNOWN_ERROR.
- `record`/`isTripped`: increments only on `DOMAIN_HEALTH_CODES`; a content code
  leaves the counter unchanged; success resets to 0; trips exactly at `threshold`;
  `threshold:0` never trips.
- `extraDelay`: 0 when healthy; escalates `base,2·base,4·base…` capped at `cap`;
  resets to 0 after a success; 0 when disabled.

Edited:
- `test/sources.test.mjs`: `SheetSource` creates/uses a `reason` column and
  `setReason` writes it; `status` column + `skipReason` semantics unchanged;
  `UrlSource.setReason` is a no-op.
- `test/pipeline.test.mjs` (injected fakes): a host that returns a domain-health
  failure `threshold` times trips → its subsequent rows are breaker-skipped (NOT
  passed to `_scrapeJob`, `setStatus` NOT called for them, `setReason` set); a
  success resets the counter (no trip); `extraDelay` grows the pre-job wait then
  resets; `maxDomainFailures:0` → no skips, today's behaviour; `setReason` is
  called with the code on a normal failure and cleared on success.

Full existing suite stays green.

Live smoke (manual): a small list with several batcave rows while the domain is
throttling → after 3 hard failures the remaining batcave rows are skipped (left
retryable), the `reason` column shows `RATE_LIMITED`/`skipped: domain
circuit-breaker`, and the summary names the tripped domain.

---

## 10. Files

```
src/breaker.mjs              NEW  CircuitBreaker, DOMAIN_HEALTH_CODES, failureCodeOf, hostOf
src/sources.mjs             EDIT  managed `reason` column + setReason (SheetSource); UrlSource no-op
src/pipeline.mjs            EDIT  build breaker in run(); _runJobs skip/record/adaptive-delay; richer _summary
src/config.mjs              EDIT  maxDomainFailures default + --max-domain-failures
scraper.config.example.json EDIT  document maxDomainFailures
test/breaker.test.mjs        NEW
test/sources.test.mjs       EDIT
test/pipeline.test.mjs      EDIT
```

---

## 11. Acceptance criteria

- After `maxDomainFailures` consecutive domain-health failures on a host in one
  run, that host's remaining rows are skipped (not scraped), left retryable
  (status untouched), and counted in the summary.
- A struggling host is slowed by a growing pre-job delay before it trips; a
  success resets both the delay and the trip counter.
- Content failures never trip the breaker or add backoff.
- Each crawled row's failure `FailureCode` is written to a new `reason` column and
  shown in the end-of-run report; the `status` column keeps `done`/`retry` and
  resume behaves exactly as before.
- `maxDomainFailures:0` disables the feature (today's behaviour), and the full
  existing test suite stays green.
- No change to `scrapeJob`, the orchestrator, strategies, validator, or capture;
  no new scraping mechanisms; no failure→mechanism routing.
