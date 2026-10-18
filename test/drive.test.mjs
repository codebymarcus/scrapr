// DriveUploader retry behavior: transient-error classification + backoff.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

// ---- DriveUploader.create: in-memory credentials (dashboard path) ----

async function inEmptyCwd(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "drive-create-"));
  const prev = process.cwd();
  process.chdir(dir); // no credentials.json / token.json here
  try {
    return await fn();
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("create: driveAuth builds the uploader without reading credentials/token files", async () => {
  await inEmptyCwd(async () => {
    const up = await DriveUploader.create(
      {
        driveCredentials: "credentials.json",
        driveToken: "token.json",
        driveAuth: { clientId: "id", clientSecret: "sec", token: { refresh_token: "r" } },
        driveFolder: null
      },
      noopLogger
    );
    assert.ok(up instanceof DriveUploader);
    assert.ok(up.drive, "drive client should be built");
    assert.equal(up.folderId, null);
  });
});

test("create: without driveAuth and without files, still throws the actionable CLI error", async () => {
  await inEmptyCwd(async () => {
    await assert.rejects(
      DriveUploader.create(
        { driveCredentials: "credentials.json", driveToken: "token.json", driveFolder: null },
        noopLogger
      ),
      /Drive credentials not found/
    );
  });
});

// ---- DriveUploader.uploadFile: returns a Drive link on both paths ----

function tmpFile(name) {
  const dir = mkdtempSync(path.join(tmpdir(), "drive-up-"));
  const p = path.join(dir, name);
  writeFileSync(p, "data");
  return { dir, p };
}

test("uploadFile: the 'already there' branch returns metadata incl. webViewLink, without creating", async () => {
  const { dir, p } = tmpFile("Series 1.cbz");
  try {
    const calls = { list: [], create: 0 };
    const drive = { files: {
      list: async (args) => { calls.list.push(args); return { data: { files: [{ id: "F1", name: "Series 1.cbz", webViewLink: "https://drive/F1" }] } }; },
      create: async () => { calls.create++; return { data: {} }; }
    } };
    const up = new DriveUploader(drive, null, noopLogger);
    const res = await up.uploadFile(p);
    assert.equal(res.id, "F1");
    assert.equal(res.webViewLink, "https://drive/F1");
    assert.equal(calls.create, 0, "no create when it already exists");
    assert.match(calls.list[0].fields, /webViewLink/, "list asks Drive for the link");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uploadFile: the create path still returns metadata incl. webViewLink", async () => {
  const { dir, p } = tmpFile("Series 2.cbz");
  try {
    const drive = { files: {
      list: async () => ({ data: { files: [] } }),
      create: async (args) => { for await (const _ of args.media.body); return { data: { id: "N1", name: "Series 2.cbz", webViewLink: "https://drive/N1" } }; }
    } };
    const up = new DriveUploader(drive, null, noopLogger);
    const res = await up.uploadFile(p);
    assert.equal(res.id, "N1");
    assert.equal(res.webViewLink, "https://drive/N1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
