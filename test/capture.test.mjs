// ImageCapture: passive collection, filtering, and capture ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ImageCapture } from "../src/capture.mjs";
import { PageCache } from "../src/cache.mjs";

async function withCache(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "scaper-cap-"));
  try {
    return await fn(await PageCache.open(path.join(base, "job")));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const noopLogger = { info() {}, warn() {}, muted() {}, success() {}, error() {}, step() {}, progressBar() {} };

// Minimal stand-in for a Playwright Response, implementing only what
// ImageCapture._onResponse reads.
function fakeImageResponse(url, { bytes = 50000, contentType = "image/jpeg", status = 200 } = {}) {
  return {
    status: () => status,
    ok: () => status >= 200 && status < 300,
    headers: () => ({ "content-type": contentType }),
    url: () => url,
    request: () => ({ resourceType: () => "image" }),
    body: async () => Buffer.alloc(bytes, 1)
  };
}

const baseConfig = { minBytes: 20000, hostFilter: null, issuePrefix: null, allImages: true, rateLimitBase: 2000 };

test("ImageCapture: stamps a monotonic seq in capture order", async () => {
  const cap = new ImageCapture(baseConfig, noopLogger);
  await cap._onResponse(fakeImageResponse("https://cdn.x/first.jpg"));
  await cap._onResponse(fakeImageResponse("https://cdn.x/second.jpg"));
  await cap._onResponse(fakeImageResponse("https://cdn.x/third.jpg"));
  const seqs = cap.list().map((e) => e.seq);
  assert.deepEqual(seqs, [0, 1, 2]);
});

test("ImageCapture: drops images below minBytes", async () => {
  const cap = new ImageCapture(baseConfig, noopLogger);
  await cap._onResponse(fakeImageResponse("https://cdn.x/tiny.jpg", { bytes: 100 }));
  assert.equal(cap.size, 0);
});

test("ImageCapture: drops an empty (0-byte) body even for a numbered page", async () => {
  const cap = new ImageCapture(baseConfig, noopLogger);
  // A numbered page normally bypasses minBytes, but a 0-byte body is a failed
  // fetch, not a real page — it must not be captured (it would crash conversion).
  await cap._onResponse(fakeImageResponse("https://cdn.x/39131/2-abc.jpg", { bytes: 0 }));
  assert.equal(cap.size, 0);
});

test("ImageCapture: de-duplicates the same URL", async () => {
  const cap = new ImageCapture(baseConfig, noopLogger);
  await cap._onResponse(fakeImageResponse("https://cdn.x/a.jpg"));
  await cap._onResponse(fakeImageResponse("https://cdn.x/a.jpg"));
  assert.equal(cap.size, 1);
});

test("lockIssueDir: forces the chapter dir so other-chapter images are skipped", async () => {
  const cap = new ImageCapture({ ...baseConfig, allImages: false }, noopLogger);
  cap.lockIssueDir("https://img.x/chap/213188/");
  await cap._onResponse(fakeImageResponse("https://img.x/chap/213188/a.jpg"));
  await cap._onResponse(fakeImageResponse("https://img.x/other/212957/b.jpg"));
  assert.deepEqual(cap.list().map((e) => e.url), ["https://img.x/chap/213188/a.jpg"]);
});

test("seedFromCache: loads cached pages and reports the seeded count", async () => {
  await withCache(async (cache) => {
    await cache.put("https://cdn.x/1.jpg", Buffer.alloc(50000, 1), "image/jpeg", 0, 1);
    await cache.put("https://cdn.x/2.jpg", Buffer.alloc(50000, 1), "image/jpeg", 1, 2);
    const cap = new ImageCapture(baseConfig, noopLogger, cache);
    const seeded = await cap.seedFromCache();
    assert.equal(seeded, 2);
    assert.equal(cap.size, 2);
  });
});

test("seedFromCache: new captures continue the seq after cached pages", async () => {
  await withCache(async (cache) => {
    await cache.put("https://cdn.x/1.jpg", Buffer.alloc(50000, 1), "image/jpeg", 0, 1);
    const cap = new ImageCapture(baseConfig, noopLogger, cache);
    await cap.seedFromCache();
    await cap._onResponse(fakeImageResponse("https://cdn.x/new.jpg"));
    const entry = cap.list().find((e) => e.url === "https://cdn.x/new.jpg");
    assert.equal(entry.seq, 1, "seq continues after the 1 seeded page");
  });
});

test("write-through: a newly captured page is persisted to the cache", async () => {
  await withCache(async (cache) => {
    const cap = new ImageCapture(baseConfig, noopLogger, cache);
    await cap._onResponse(fakeImageResponse("https://cdn.x/p.jpg"));
    assert.equal(cache.has("https://cdn.x/p.jpg"), true);
    assert.equal((await cache.get("https://cdn.x/p.jpg")).buffer.length, 50000);
  });
});

test("seedFromCache: restores the issue-directory lock", async () => {
  await withCache(async (cache) => {
    cache.issueDir = "https://cdn.x/A/";
    await cache.saveIndex();
    const cap = new ImageCapture({ ...baseConfig, allImages: false }, noopLogger, cache);
    await cap.seedFromCache();
    // A page from a different directory must be rejected by the restored lock.
    await cap._onResponse(fakeImageResponse("https://cdn.x/B/other.jpg"));
    assert.equal(cap.has("https://cdn.x/B/other.jpg"), false);
  });
});

test("captures a numbered page even when it is just under minBytes", async () => {
  // Real bug: batcave page 14 was 19922 bytes with minBytes 20000 → dropped,
  // leaving the download stuck at 22/23 forever.
  const cap = new ImageCapture({ ...baseConfig, minBytes: 20000 }, noopLogger);
  await cap._onResponse(fakeImageResponse("https://img.x/31/30402/213558/14-abc123.jpg", { bytes: 19922 }));
  assert.equal(cap.size, 1);
});

test("still drops a small NON-numbered image (icon/thumbnail)", async () => {
  const cap = new ImageCapture({ ...baseConfig, minBytes: 20000 }, noopLogger);
  await cap._onResponse(fakeImageResponse("https://x/templates/loading.gif", { bytes: 8566, contentType: "image/gif" }));
  assert.equal(cap.size, 0);
});

test("wasServedFromCache: tracks cache-route hits for the bandwidth meter", () => {
  const cap = new ImageCapture(baseConfig, noopLogger, null);
  assert.equal(cap.wasServedFromCache("https://x/a.jpg"), false);
  cap._markServed("https://x/a.jpg");
  assert.equal(cap.wasServedFromCache("https://x/a.jpg"), true);
});
