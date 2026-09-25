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
