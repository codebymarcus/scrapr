// PageCache: per-job on-disk cache of downloaded pages, keyed by URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PageCache } from "../src/cache.mjs";

async function withCacheDir(fn) {
  const base = await mkdtemp(path.join(tmpdir(), "scaper-cache-"));
  const dir = path.join(base, "job");
  try {
    return await fn(dir);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const buf = (s) => Buffer.from(s);

test("open: a fresh dir starts empty", async () => {
  await withCacheDir(async (dir) => {
    const cache = await PageCache.open(dir);
    assert.equal(cache.size, 0);
    assert.equal(cache.has("https://x/1.jpg"), false);
  });
});

test("put/get: stores bytes + metadata and writes a file to disk", async () => {
  await withCacheDir(async (dir) => {
    const cache = await PageCache.open(dir);
    await cache.put("https://x/1.jpg", buf("PAGE1"), "image/jpeg", 0, 1);
    assert.equal(cache.has("https://x/1.jpg"), true);
    assert.equal(cache.size, 1);
    const got = await cache.get("https://x/1.jpg");
    assert.equal(got.buffer.toString(), "PAGE1");
    assert.equal(got.contentType, "image/jpeg");
    assert.equal(got.seq, 0);
    assert.equal(got.page, 1);
  });
});

test("readAll: returns every cached page with its buffer", async () => {
  await withCacheDir(async (dir) => {
    const cache = await PageCache.open(dir);
    await cache.put("https://x/1.jpg", buf("A"), "image/jpeg", 0, 1);
    await cache.put("https://x/2.jpg", buf("B"), "image/jpeg", 1, 2);
    const all = await cache.readAll();
    assert.equal(all.length, 2);
    const byUrl = Object.fromEntries(all.map((e) => [e.url, e.buffer.toString()]));
    assert.deepEqual(byUrl, { "https://x/1.jpg": "A", "https://x/2.jpg": "B" });
  });
});

test("persistence: a new PageCache on the same dir sees earlier writes", async () => {
  await withCacheDir(async (dir) => {
    const a = await PageCache.open(dir);
    await a.put("https://x/1.jpg", buf("PAGE1"), "image/jpeg", 0, 1);
    a.total = 50;
    a.issueDir = "https://x/";
    await a.saveIndex();

    const b = await PageCache.open(dir);
    assert.equal(b.size, 1);
    assert.equal(b.total, 50);
    assert.equal(b.issueDir, "https://x/");
    assert.equal((await b.get("https://x/1.jpg")).buffer.toString(), "PAGE1");
  });
});

test("clear: removes the cache dir and empties the cache", async () => {
  await withCacheDir(async (dir) => {
    const cache = await PageCache.open(dir);
    await cache.put("https://x/1.jpg", buf("A"), "image/jpeg", 0, 1);
    await cache.clear();
    await assert.rejects(stat(dir), "dir should be gone");
    const reopened = await PageCache.open(dir);
    assert.equal(reopened.size, 0);
  });
});
