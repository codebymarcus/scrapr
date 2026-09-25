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
