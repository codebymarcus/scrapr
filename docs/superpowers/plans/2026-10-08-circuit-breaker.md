# Circuit Breaker + Failure Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-domain circuit breaker with adaptive backoff to the batch loop (stop/slow a domain that keeps failing hard, leaving its rows retryable) and surface each job's FailureCode in a new sheet `reason` column + the end-of-run report.

**Architecture:** A pure `CircuitBreaker` (`src/breaker.mjs`) holds per-domain failure state for one run; `BatchRunner._runJobs` consults it (skip tripped domains, grow the pre-job delay) and records each outcome via `failureCodeOf(result)`. `SheetSource` gains a managed `reason` column. No change to `scrapeJob`, the orchestrator, strategies, validator, or capture.

**Tech Stack:** Node.js ESM (`.mjs`), `xlsx`, `node --test` + `node:assert/strict`.

**Spec:** [docs/superpowers/specs/2026-10-08-circuit-breaker-failure-classification-design.md](../specs/2026-10-08-circuit-breaker-failure-classification-design.md)

## Global Constraints

- ES modules only (`.mjs`), no new runtime dependencies.
- Batch-level only: do NOT change `src/scrapeJob`, `src/orchestrator.mjs`, strategies, `src/result-validator.mjs`, or `src/capture.mjs`.
- `maxDomainFailures: 0` fully disables the breaker AND the adaptive backoff → today's behaviour byte-for-byte.
- Only `DOMAIN_HEALTH_CODES` (`RATE_LIMITED, BLOCKED, HTTP_ERROR, TIMEOUT, NETWORK_ERROR`) count toward the breaker/backoff. Content failures (`INCOMPLETE_RESULT, EMPTY_RESULT, NAVIGATION_JUMP, PARSER_ERROR, UNKNOWN_ERROR`) never trip it.
- The `status` column keeps its exact semantics (`done`/`retry`, `skipReason` unchanged); the FailureCode lives only in the new `reason` column. A breaker-skipped row gets a `reason` but NO `setStatus` (stays retryable).
- Breaker is best-effort: never throws into the job loop; a `setReason` write failure warns and continues.
- Tests use `node:test` + `node:assert/strict`, fakes, no real browser.
- Commit after each task; message ends with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Review Focus

- **A row whose host already tripped** → skipped WITHOUT scraping and WITHOUT `setStatus` (status stays retryable); `reason` set (Task 4).
- **Content failures must not trip the breaker** → an `INCOMPLETE_RESULT`/`EMPTY_RESULT` run never increments the counter or adds backoff (Task 1).
- **`maxDomainFailures:0` disables everything** → no skips, no backoff, `setStatus` behaviour unchanged (Tasks 1 & 4).
- **A success resets the host counter** → a domain that recovers mid-run is not skipped later (Task 1).
- **The new `reason` column must not disturb the `status` column** → existing status read/write/resume semantics unchanged; `reason` is separate (Task 2).

---

## Task 1: Circuit breaker module (`src/breaker.mjs`)

**Files:**
- Create: `src/breaker.mjs`
- Test: `test/breaker.test.mjs`

**Interfaces:**
- Consumes: `FailureCode`, `mapError` from `src/strategies/strategy.mjs`.
- Produces:
  - `DOMAIN_HEALTH_CODES` (Set)
  - `hostOf(url) → string`
  - `failureCodeOf(result) → FailureCode|null`
  - `class CircuitBreaker(threshold, { base, cap })` with `enabled()`, `record(host,{ok,code})`, `isTripped(host)`, `extraDelay(host)`, `noteSkip()`, `trippedHosts()`, and a `skippedCount` field.

- [ ] **Step 1: Write the failing test**

```js
// test/breaker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, DOMAIN_HEALTH_CODES, hostOf, failureCodeOf } from "../src/breaker.mjs";

test("hostOf: hostname from a URL; raw string on a bad URL", () => {
  assert.equal(hostOf("https://BatCave.biz/event/x/1"), "batcave.biz");
  assert.equal(hostOf("not a url"), "not a url");
});

test("failureCodeOf: ok → null; exception → mapped; attempts → last code; empty → UNKNOWN", () => {
  assert.equal(failureCodeOf({ ok: true }), null);
  assert.equal(failureCodeOf({ ok: false, error: "net::ERR_CONNECTION_RESET" }), "NETWORK_ERROR");
  assert.equal(failureCodeOf({ ok: false, attempts: [{ code: "TIMEOUT" }, { code: "RATE_LIMITED" }] }), "RATE_LIMITED");
  assert.equal(failureCodeOf({ ok: false }), "UNKNOWN_ERROR");
});

test("record/isTripped: increments only on domain-health codes, trips at threshold", () => {
  const b = new CircuitBreaker(3, { base: 1000, cap: 10000 });
  b.record("h", { ok: false, code: "RATE_LIMITED" });
  b.record("h", { ok: false, code: "INCOMPLETE_RESULT" }); // content: ignored
  b.record("h", { ok: false, code: "BLOCKED" });
  assert.equal(b.isTripped("h"), false, "2 health failures < threshold");
  b.record("h", { ok: false, code: "TIMEOUT" });
  assert.equal(b.isTripped("h"), true, "3rd health failure trips");
});

test("record: a success resets the counter (domain recovered)", () => {
  const b = new CircuitBreaker(2, { base: 1000 });
  b.record("h", { ok: false, code: "BLOCKED" });
  b.record("h", { ok: true });
  b.record("h", { ok: false, code: "BLOCKED" });
  assert.equal(b.isTripped("h"), false, "counter reset by the success in between");
});

test("extraDelay: 0 when healthy; escalates base·2^(n-1) capped at cap; resets on success", () => {
  const b = new CircuitBreaker(5, { base: 1000, cap: 4000 });
  assert.equal(b.extraDelay("h"), 0);
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=1
  assert.equal(b.extraDelay("h"), 1000);
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=2
  assert.equal(b.extraDelay("h"), 2000);
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=3 → 4000
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=4 → 8000 capped to 4000
  assert.equal(b.extraDelay("h"), 4000);
  b.record("h", { ok: true });
  assert.equal(b.extraDelay("h"), 0);
});

test("threshold 0 disables: never trips, no backoff", () => {
  const b = new CircuitBreaker(0, { base: 1000 });
  for (let i = 0; i < 10; i++) b.record("h", { ok: false, code: "BLOCKED" });
  assert.equal(b.isTripped("h"), false);
  assert.equal(b.extraDelay("h"), 0);
  assert.equal(b.enabled(), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/breaker.test.mjs`
Expected: FAIL — cannot find module `../src/breaker.mjs`.

- [ ] **Step 3: Write the implementation**

```js
// src/breaker.mjs
// Per-domain circuit breaker + adaptive backoff for one batch run. Pure and
// stateful; no I/O. The batch loop records each job's outcome and consults it to
// slow (extraDelay) then skip (isTripped) a domain that keeps failing hard.
import { FailureCode, mapError } from "./strategies/strategy.mjs";

// Codes that mean the domain/server is unhealthy — the only ones that count
// toward the breaker and the backoff. Content failures and UNKNOWN_ERROR do not,
// so a flaky chapter can't blacklist a healthy domain.
export const DOMAIN_HEALTH_CODES = new Set([
  FailureCode.RATE_LIMITED,
  FailureCode.BLOCKED,
  FailureCode.HTTP_ERROR,
  FailureCode.TIMEOUT,
  FailureCode.NETWORK_ERROR
]);

// The hostname key for a job URL (stable even on a malformed URL).
export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return String(url); }
}

// The primary FailureCode of a finished job result, or null when it succeeded.
export function failureCodeOf(result) {
  if (!result || result.ok) return null;
  if (result.error) return mapError(result.error);
  const attempts = result.attempts;
  if (Array.isArray(attempts) && attempts.length) {
    return attempts[attempts.length - 1].code || FailureCode.UNKNOWN_ERROR;
  }
  return FailureCode.UNKNOWN_ERROR;
}

export class CircuitBreaker {
  constructor(threshold = 3, { base = 3000, cap = 60000 } = {}) {
    this.threshold = Number.isInteger(threshold) ? threshold : 3;
    this.base = base;
    this.cap = cap;
    this._fails = new Map();   // host -> consecutive domain-health failures
    this._tripped = new Set();
    this.skippedCount = 0;
  }

  enabled() { return this.threshold > 0; }

  record(host, { ok, code } = {}) {
    if (!this.enabled()) return;
    if (ok) { this._fails.set(host, 0); return; }
    if (!DOMAIN_HEALTH_CODES.has(code)) return;
    const n = (this._fails.get(host) || 0) + 1;
    this._fails.set(host, n);
    if (n >= this.threshold) this._tripped.add(host);
  }

  isTripped(host) { return this.enabled() && this._tripped.has(host); }

  extraDelay(host) {
    if (!this.enabled()) return 0;
    const n = this._fails.get(host) || 0;
    if (n <= 0) return 0;
    return Math.min(this.cap, this.base * 2 ** (n - 1));
  }

  noteSkip() { this.skippedCount++; }

  trippedHosts() { return [...this._tripped]; }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test test/breaker.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/breaker.mjs test/breaker.test.mjs
git commit -m "feat(breaker): per-domain circuit breaker + adaptive backoff + failure classification helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Managed `reason` column in the sheet (`src/sources.mjs`)

**Files:**
- Modify: `src/sources.mjs`
- Test: `test/sources.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `SheetSource.setReason(job, text)` (writes a managed `reason` column); `UrlSource.setReason()` no-op. `load()` finds/creates the `reason` column alongside `status`.

- [ ] **Step 1: Write the failing tests**

Append to `test/sources.test.mjs`:
```js
test("SheetSource: appends a reason column and setReason writes it", async () => {
  await withTempCsv("url,name\nhttps://x/1,Issue 1\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    src.setReason(jobs[0], "BLOCKED");
    const text = await readFile(file, "utf8");
    assert.match(text.split("\n")[0], /reason/, "reason header present");
    assert.match(text, /BLOCKED/);
  });
});

test("SheetSource: an existing reason column is reused, not duplicated", async () => {
  await withTempCsv("url,status,reason\nhttps://x/1,,\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    src.setReason(jobs[0], "RATE_LIMITED");
    const text = await readFile(file, "utf8");
    const header = text.split("\n")[0];
    assert.equal(header.match(/reason/g)?.length, 1, "only one reason column");
    assert.match(text, /RATE_LIMITED/);
  });
});

test("SheetSource: setStatus still works and is independent of reason", async () => {
  await withTempCsv("url,name\nhttps://x/1,Issue 1\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    src.setStatus(jobs[0], "done");
    src.setReason(jobs[0], "");
    const text = await readFile(file, "utf8");
    assert.match(text, /done/);
  });
});

test("UrlSource: setReason is a no-op (does not throw)", async () => {
  const src = new UrlSource("https://x/read");
  await src.load();
  assert.doesNotThrow(() => src.setReason({ row: -1 }, "X"));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/sources.test.mjs`
Expected: the new tests FAIL (`setReason` is not a function; no `reason` header).

- [ ] **Step 3: Implement in `src/sources.mjs`**

Add `setReason` no-op to `UrlSource`:
```js
export class UrlSource {
  constructor(url) {
    this.url = url;
    this.hasStatus = false;
  }
  async load() {
    return [{ url: this.url, name: null, status: "", row: -1 }];
  }
  setStatus() {}
  setReason() {}
}
```

In `SheetSource`: add `this._reasonCol = -1;` to the constructor (next to `this._statusCol = -1;`).

In `load()`, right after the `this._statusCol = statusCol; this.hasStatus = true;` lines, add the reason-column resolution (uses the possibly-grown `range.e.c`):
```js
    let reasonCol = find(["reason", "error", "note"]);
    if (reasonCol === -1) {
      reasonCol = range.e.c + 1; // append a reason column and grow the range
      ws[xlsx.utils.encode_cell({ r: hr, c: reasonCol })] = { t: "s", v: "reason" };
      range.e.c = reasonCol;
      ws["!ref"] = xlsx.utils.encode_range(range);
    }
    this._reasonCol = reasonCol;
```

Extract the write-back into a private `_save()` and use it from both setters:
```js
  _save() {
    try {
      if (this._isText) {
        const FS = /\.tsv$/i.test(this.file) ? "\t" : ",";
        writeFileSync(this.file, xlsx.utils.sheet_to_csv(this._ws, { FS }));
      } else {
        xlsx.writeFile(this._wb, this.file);
      }
    } catch (e) {
      this.logger?.warn(`couldn't write back to ${this.file} (${e.message}). Is it open in Excel?`);
    }
  }

  setStatus(job, value) {
    if (!this.hasStatus || job.row < 0) return;
    this._ws[xlsx.utils.encode_cell({ r: job.row, c: this._statusCol })] = { t: "s", v: value };
    this._save();
  }

  setReason(job, text) {
    if (!this.hasStatus || job.row < 0 || this._reasonCol < 0) return;
    this._ws[xlsx.utils.encode_cell({ r: job.row, c: this._reasonCol })] = { t: "s", v: String(text ?? "") };
    this._save();
  }
```

Update the class-doc comment at the top of `sources.mjs` to mention `setReason` alongside `setStatus` in the shared interface.

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/sources.test.mjs`
Expected: PASS (all — the 4 new plus the pre-existing status/headerless tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/sources.mjs test/sources.test.mjs
git commit -m "feat(sources): managed reason column + setReason alongside status

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Config knob (`maxDomainFailures`)

**Files:**
- Modify: `src/config.mjs`
- Test: `test/config.test.mjs` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `config.maxDomainFailures` (default 3; `--max-domain-failures <n>`).

- [ ] **Step 1: Write the failing tests**

Append to `test/config.test.mjs`:
```js
test("maxDomainFailures: defaults to 3", () => {
  const cfg = buildConfig({ _: ["https://x/read"] }, {});
  assert.equal(cfg.maxDomainFailures, 3);
});

test("maxDomainFailures: --max-domain-failures overrides (clamped ≥ 0)", () => {
  assert.equal(buildConfig({ _: ["https://x/read"], "max-domain-failures": "5" }, {}).maxDomainFailures, 5);
  assert.equal(buildConfig({ _: ["https://x/read"], "max-domain-failures": "-2" }, {}).maxDomainFailures, 0);
});

test("maxDomainFailures: config file value is honored", () => {
  const cfg = buildConfig({ _: ["https://x/read"] }, { maxDomainFailures: 0 });
  assert.equal(cfg.maxDomainFailures, 0);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/config.test.mjs`
Expected: the new tests FAIL (`maxDomainFailures` is `undefined`).

- [ ] **Step 3: Implement in `src/config.mjs`**

Add to the `DEFAULTS` object (near `itemDelay`):
```js
  // circuit breaker: consecutive domain-health failures on one host before it is
  // skipped for the rest of the run (rows stay retryable); grows the delay before
  // then. 0 disables the breaker and the adaptive backoff.
  maxDomainFailures: 3,
```

In `buildConfig`, in the CLI-override section (near the `max-retries` line), add:
```js
  if (has("max-domain-failures")) cfg.maxDomainFailures = Math.max(0, num(args["max-domain-failures"], cfg.maxDomainFailures));
```

(The config-file layer already copies `maxDomainFailures` when present, since it is a known `DEFAULTS` key. A `0` in the file is honored because `0 !== null`.)

- [ ] **Step 4: Run to verify they pass**

Run: `node --test test/config.test.mjs`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs test/config.test.mjs
git commit -m "feat(config): maxDomainFailures knob (circuit-breaker threshold)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire the breaker into the batch loop (`src/pipeline.mjs`)

**Files:**
- Modify: `src/pipeline.mjs`
- Modify: `scraper.config.example.json`
- Test: `test/pipeline.test.mjs` (append)

**Interfaces:**
- Consumes: `CircuitBreaker`, `hostOf`, `failureCodeOf` from `src/breaker.mjs` (Task 1); `source.setReason` (Task 2); `config.maxDomainFailures` (Task 3).
- Produces: breaker-aware `_runJobs` (skip tripped hosts, adaptive pre-job delay, record outcomes, write `reason`); enriched `_summary`.

- [ ] **Step 1: Write the failing tests**

Append to `test/pipeline.test.mjs`:
```js
import { CircuitBreaker } from "../src/breaker.mjs";

test("_runJobs: trips a domain after threshold hard failures and skips its remaining rows", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 2 }, noopLogger);
  const scraped = [];
  const statuses = {}; const reasons = {};
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  runner._scrapeJob = async (s, job) => {
    scraped.push(job.url);
    return { saved: 0, total: 10, complete: false, attempts: [{ name: "current", status: "failed", code: "RATE_LIMITED" }] };
  };
  const source = { hasStatus: true, setStatus: (j, v) => { statuses[j.url] = v; }, setReason: (j, v) => { reasons[j.url] = v; } };
  const jobs = [
    { url: "https://d.co/1", status: "", row: 1 },
    { url: "https://d.co/2", status: "", row: 2 },
    { url: "https://d.co/3", status: "", row: 3 }
  ];
  const breaker = new CircuitBreaker(2, { base: 0 });
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null, breaker });
  assert.deepEqual(scraped, ["https://d.co/1", "https://d.co/2"], "row 3 skipped after 2 failures tripped the domain");
  assert.equal(statuses["https://d.co/3"], undefined, "skipped row's status untouched (stays retryable)");
  assert.match(reasons["https://d.co/3"], /circuit-breaker/);
  assert.equal(reasons["https://d.co/1"], "RATE_LIMITED", "failure code written to reason");
});

test("_runJobs: a success resets the counter so the domain is not skipped", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 2 }, noopLogger);
  const scraped = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  let call = 0;
  runner._scrapeJob = async (s, job) => {
    scraped.push(job.url);
    call++;
    const fail = call !== 2; // row 2 succeeds, rows 1 and 3 fail
    return fail
      ? { saved: 0, total: 10, complete: false, attempts: [{ name: "current", status: "failed", code: "BLOCKED" }] }
      : { saved: 10, total: 10, complete: true, attempts: [] };
  };
  const source = { hasStatus: true, setStatus() {}, setReason() {} };
  const jobs = [
    { url: "https://d.co/1", status: "", row: 1 },
    { url: "https://d.co/2", status: "", row: 2 },
    { url: "https://d.co/3", status: "", row: 3 }
  ];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(2, { base: 0 }) });
  assert.deepEqual(scraped, ["https://d.co/1", "https://d.co/2", "https://d.co/3"], "no trip: success reset the counter");
});

test("_runJobs: maxDomainFailures 0 (disabled) never skips", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0 }, noopLogger);
  const scraped = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  runner._scrapeJob = async (s, job) => { scraped.push(job.url); return { saved: 0, total: 1, complete: false, attempts: [{ name: "current", status: "failed", code: "BLOCKED" }] }; };
  const source = { hasStatus: true, setStatus() {}, setReason() {} };
  const jobs = [{ url: "https://d.co/1", status: "", row: 1 }, { url: "https://d.co/2", status: "", row: 2 }, { url: "https://d.co/3", status: "", row: 3 }];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.equal(scraped.length, 3, "all rows attempted when breaker disabled");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/pipeline.test.mjs`
Expected: the new tests FAIL (`_runJobs` ignores `breaker`; no skip/reason behaviour).

- [ ] **Step 3: Add imports to `src/pipeline.mjs`**

```js
import { CircuitBreaker, hostOf, failureCodeOf } from "./breaker.mjs";
```

- [ ] **Step 4: Build the breaker in `run()` and pass it to `_runJobs`**

In `run()`, before launching the browser (near where `orchestrator`-era setup was), create the breaker and include it in the `_runJobs` call:
```js
    const breaker = new CircuitBreaker(this.config.maxDomainFailures, { base: this.config.itemDelay || 3000 });
```
and change the `_runJobs` call to:
```js
      results = await this._runJobs({ jobs, source, session, processor, packagers, uploader, breaker });
```
Change `_summary` call to pass the breaker:
```js
    return this._summary(jobs, results, breaker);
```

- [ ] **Step 5: Update `_runJobs` to destructure and use the breaker**

Change the signature to accept `breaker`, defaulting to a disabled one for direct unit calls that omit it, and insert the skip/delay/record logic. The new per-job body:
```js
  async _runJobs({ jobs, source, session, processor, packagers, uploader, breaker }) {
    const brk = breaker || new CircuitBreaker(0);
    const results = [];
    let scrapedAny = false;
    for (let i = 0; i < jobs.length; i++) {
      if (this._stopping) {
        const left = jobs.length - i;
        this.logger.warn(`stopped — ${left} job(s) left unprocessed (rerun to resume).`);
        break;
      }
      const job = jobs[i];
      const tag = `(${i + 1}/${jobs.length})`;

      if (source.hasStatus) {
        const skip = skipReason(job.status);
        if (skip) {
          this.logger.muted(`${tag} ${skip} — ${job.url}`);
          results.push({ ...job, skipped: true });
          continue;
        }
      }

      const host = hostOf(job.url);
      if (brk.isTripped(host)) {
        brk.noteSkip();
        this.logger.muted(`${tag} skipped — ${host} circuit-breaker tripped (left to retry) — ${job.url}`);
        results.push({ ...job, skipped: true, breakerSkipped: true });
        source.setReason?.(job, "skipped: domain circuit-breaker");
        continue;
      }

      const extra = brk.extraDelay(host);
      const waitMs = (scrapedAny ? this.config.itemDelay : 0) + extra;
      if (extra > 0) this.logger.verbose?.(`backing off ${host} ${Math.round(extra / 1000)}s`);
      if (waitMs > 0) await sleep(withJitter(waitMs, this.config.jitter));
      scrapedAny = true;

      if (jobs.length > 1) this.logger.section(`=== ${tag}${job.status === "retry" ? " [retry]" : ""} ${job.url} ===`);

      let complete = false;
      let rec;
      try {
        const profile = this._resolveProfile(job.url);
        const strategies = this._resolvePipeline(profile, this.config, this.logger);
        this.logger.verbose(`profile=${profile.name} contentType=${profile.contentType} pipeline=[${strategies.map((s) => s.strategy.name).join(", ")}]`);
        if (!strategies.length) {
          this.logger.error(`no mechanisms resolved for ${job.url} (profile ${profile.name}) — marking retry`);
          rec = { ...job, saved: 0, ok: false, error: "no mechanisms resolved" };
        } else {
          const orchestrator = new ScrapingOrchestrator(strategies, this._validate, this.logger);
          const r = await this._scrapeJob(session, job, this.config, processor, packagers, uploader, this.logger, orchestrator, profile);
          complete = r.complete;
          rec = { ...job, ...r, ok: complete };
        }
      } catch (e) {
        this.logger.error(`failed on ${job.url}: ${e?.message || e}`);
        rec = { ...job, saved: 0, ok: false, error: String(e?.message || e) };
      }
      results.push(rec);

      const code = failureCodeOf(rec);
      brk.record(host, { ok: complete, code });
      if (source.hasStatus) {
        source.setStatus(job, complete ? "done" : "retry");
        source.setReason?.(job, complete ? "" : (code || "FAILED"));
      }
    }
    return results;
  }
```
This preserves every existing behaviour when the breaker is disabled (`isTripped` false, `extraDelay` 0): the wait equals the old `scrapedAny ? itemDelay : 0`, and `setStatus` is called exactly as before (now paired with a `setReason`).

- [ ] **Step 6: Enrich `_summary`**

Change the signature to `_summary(jobs, results, breaker)` and extend the failed-jobs block + add tripped-domain lines:
```js
  _summary(jobs, results, breaker) {
    if (jobs.length > 1) {
      const attempted = results.filter((r) => !r.skipped);
      const ok = attempted.filter((r) => r.ok).length;
      const skipped = results.filter((r) => r.skipped).length;
      const failed = attempted.filter((r) => !r.ok);
      const summary = `batch done: ${ok}/${attempted.length} crawled succeeded${skipped ? `, ${skipped} skipped` : ""}${failed.length ? `, ${failed.length} to retry` : ""}.`;
      this.logger.section(summary);
      const totalBytes = attempted.reduce((s, r) => s + (r.bytes || 0), 0);
      const totalReqs = attempted.reduce((s, r) => s + (r.requests || 0), 0);
      if (totalBytes > 0) {
        this.logger.info(`total bandwidth: ${formatBandwidth(totalBytes, totalReqs, this.config.costPerGb)}`);
      }
      if (failed.length) {
        this.logger.warn("marked retry:");
        for (const f of failed) {
          const code = failureCodeOf(f);
          const mech = f.usedStrategy || "";
          const detail = code ? `${code}${mech ? `, ${mech}` : ""}` : `${f.saved || 0}/${f.total || "?"} pages`;
          this.logger.warn(`  - ${f.url} (${detail})`);
        }
      }
      const tripped = breaker?.trippedHosts?.() || [];
      if (tripped.length) {
        this.logger.warn("circuit breaker tripped:");
        for (const host of tripped) {
          const n = results.filter((r) => r.breakerSkipped && hostOf(r.url) === host).length;
          this.logger.warn(`  - ${host}: too many failures → ${n} row(s) skipped this run (left to retry)`);
        }
      }
      return failed.length && ok === 0 ? 2 : 0;
    }
    return results[0]?.ok ? 0 : 2;
  }
```

- [ ] **Step 7: Document the knob**

In `scraper.config.example.json`, add in the navigation/pacing area:
```jsonc
  "maxDomainFailures": 3,       // circuit breaker: after N consecutive rate-limit/block/timeout failures on one host in a run, skip its remaining rows (left to retry) and grow the delay before then. 0 disables.
```
(Place it as a valid key with the surrounding comma style; keep the file parseable by the comment-stripping loader.)

- [ ] **Step 8: Run the pipeline tests + full suite**

Run: `node --test test/pipeline.test.mjs`
Expected: PASS — the three new tests plus all existing `_runJobs`/`scrapeJob`/`describeDryRun`/`decideOutcome` tests (existing `_runJobs` tests omit `breaker` → a disabled breaker is used, and `setReason?.` is optional-chained so their fake sources without `setReason` are unaffected).

Run: `npm test`
Expected: PASS — every file green.

- [ ] **Step 9: Commit**

```bash
git add src/pipeline.mjs scraper.config.example.json test/pipeline.test.mjs
git commit -m "feat(pipeline): per-domain circuit breaker, adaptive backoff, reason + report

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Full suite:** `npm test` → all green.
- [ ] **Dry-run smoke:** `node scrape.mjs https://batcave.biz/event/ultimate-marvel/395 --dry-run` → preview prints, exits 0.
- [ ] **Disabled-path smoke:** confirm `maxDomainFailures:0` in a config yields identical batch behaviour to before (no skips, no reason writes needed — though `setReason` with the code still runs harmlessly on a real sheet).
- [ ] **Live smoke (optional, network):** a small CSV with several same-domain rows while the domain throttles → after `maxDomainFailures` hard failures the remaining rows are skipped (status left blank/retry), the `reason` column shows the code / `skipped: domain circuit-breaker`, and the summary names the tripped domain.
```
Inspect the sheet's reason column, e.g.: column added by the run shows RATE_LIMITED / skipped: domain circuit-breaker
```
