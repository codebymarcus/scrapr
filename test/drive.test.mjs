// DriveUploader retry behavior: transient-error classification + backoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveUploader, isRetryable } from "../src/drive.mjs";

const noopLogger = { info() {}, warn() {}, muted() {}, success() {}, error() {}, step() {}, progressBar() {} };

test("isRetryable: 5xx and 429 are retryable", () => {
  assert.equal(isRetryable({ code: 503 }), true);
  assert.equal(isRetryable({ code: 500 }), true);
  assert.equal(isRetryable({ code: 429 }), true);
  assert.equal(isRetryable({ response: { status: 502 } }), true);
});

test("isRetryable: 403 only when it is a rate-limit reason", () => {
  assert.equal(isRetryable({ code: 403, errors: [{ reason: "rateLimitExceeded" }] }), true);
  assert.equal(isRetryable({ code: 403, errors: [{ reason: "userRateLimitExceeded" }] }), true);
  assert.equal(isRetryable({ code: 403, errors: [{ reason: "insufficientPermissions" }] }), false);
});

test("isRetryable: transient network errors are retryable", () => {
  assert.equal(isRetryable({ code: "ECONNRESET" }), true);
  assert.equal(isRetryable({ code: "ETIMEDOUT" }), true);
});

test("isRetryable: client errors are not retryable", () => {
  assert.equal(isRetryable({ code: 404 }), false);
  assert.equal(isRetryable({ code: 401 }), false);
});

test("_withRetry: retries a transient failure then succeeds", async () => {
  const up = new DriveUploader(null, null, noopLogger, { maxRetries: 3, rateLimitBase: 1 });
  let attempts = 0;
  const result = await up._withRetry(async () => {
    attempts++;
    if (attempts < 3) throw { code: 503 };
    return "ok";
  }, "upload");
  assert.equal(result, "ok");
  assert.equal(attempts, 3);
});

test("_withRetry: does not retry a non-retryable error", async () => {
  const up = new DriveUploader(null, null, noopLogger, { maxRetries: 3, rateLimitBase: 1 });
  let attempts = 0;
  await assert.rejects(
    up._withRetry(async () => {
      attempts++;
      throw { code: 404 };
    }, "upload"),
    (e) => e.code === 404
  );
  assert.equal(attempts, 1);
});

test("_withRetry: gives up after maxRetries and rethrows", async () => {
  const up = new DriveUploader(null, null, noopLogger, { maxRetries: 2, rateLimitBase: 1 });
  let attempts = 0;
  await assert.rejects(
    up._withRetry(async () => {
      attempts++;
      throw { code: 500 };
    }, "upload"),
    (e) => e.code === 500
  );
  assert.equal(attempts, 3, "1 initial + 2 retries");
});
