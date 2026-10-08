// Job sources: CSV parsing, header/status-column handling, status write-back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SheetSource, UrlSource } from "../src/sources.mjs";

async function withTempCsv(contents, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "scaper-src-"));
  const file = path.join(dir, "links.csv");
  await writeFile(file, contents);
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("UrlSource: yields one job, no status tracking", async () => {
  const src = new UrlSource("https://x/read");
  const jobs = await src.load();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].url, "https://x/read");
  assert.equal(src.hasStatus, false);
});

test("SheetSource: reads url + name columns, appends a status column", async () => {
  await withTempCsv("url,name\nhttps://x/1,Issue 1\nhttps://x/2,Issue 2\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    assert.equal(src.hasStatus, true);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].url, "https://x/1");
    assert.equal(jobs[0].name, "Issue 1");
    assert.equal(jobs[0].status, "");
  });
});

test("SheetSource: existing status column is read, not duplicated", async () => {
  await withTempCsv("url,status\nhttps://x/1,done\nhttps://x/2,\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    assert.equal(jobs[0].status, "done");
    assert.equal(jobs[1].status, "");
  });
});

test("SheetSource: setStatus writes back to the file", async () => {
  await withTempCsv("url,name\nhttps://x/1,Issue 1\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    src.setStatus(jobs[0], "done");
    const text = await readFile(file, "utf8");
    assert.match(text, /done/);
  });
});

test("SheetSource: headerless sheet reads first column as links, no status", async () => {
  await withTempCsv("https://x/1\nhttps://x/2\nnot-a-link\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    assert.equal(src.hasStatus, false);
    assert.equal(jobs.length, 2, "only http(s) rows kept");
    assert.equal(jobs[0].url, "https://x/1");
  });
});

test("SheetSource: skips rows without a valid http(s) url", async () => {
  await withTempCsv("url,name\nhttps://x/1,ok\n,blank\nftp://x/2,bad-scheme\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].url, "https://x/1");
  });
});

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

test("SheetSource: a user `note` column is not adopted as the reason column", async () => {
  await withTempCsv("url,note\nhttps://x/1,keep me\n", async (file) => {
    const src = new SheetSource(file);
    const jobs = await src.load();
    src.setReason(jobs[0], "BLOCKED");
    src.setStatus(jobs[0], "retry");
    const text = await readFile(file, "utf8");
    assert.match(text.split("\n")[0], /\breason\b/, "a reason column was appended");
    assert.match(text, /keep me/, "the user's note column is preserved, not overwritten");
  });
});
