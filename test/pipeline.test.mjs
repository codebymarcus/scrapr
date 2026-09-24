// Pipeline helpers: skip reasoning and the --dry-run preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { skipReason, describeDryRun, decideOutcome, BatchRunner } from "../src/pipeline.mjs";

const noopLogger = {
  info() {}, warn() {}, muted() {}, success() {}, error() {}, step() {}, section() {}, progressBar() {}
};

test("skipReason: only blank and retry are crawled", () => {
  assert.equal(skipReason(""), null);
  assert.equal(skipReason("retry"), null);
  assert.equal(skipReason("done"), "already done");
  assert.equal(skipReason("skip"), "skip");
  assert.match(skipReason("weird"), /leaving alone/);
});

test("describeDryRun: single URL shows resolved targets", () => {
  const config = { listFile: null, out: "myout", cbz: true, keepLoose: false };
  const jobs = [{ url: "https://x/read", name: null, status: "", row: -1 }];
  const lines = describeDryRun(config, jobs).join("\n");
  assert.match(lines, /https:\/\/x\/read/);
  assert.match(lines, /myout\.cbz/);
});

test("describeDryRun: batch marks skipped rows with their reason", () => {
  const config = { listFile: "l.csv", out: "downloads", cbz: true, keepLoose: false };
  const jobs = [
    { url: "https://x/1", name: "One", status: "done", row: 1 },
    { url: "https://x/2", name: "Two", status: "", row: 2 }
  ];
  const lines = describeDryRun(config, jobs).join("\n");
  assert.match(lines, /already done/);
  assert.match(lines, /will scrape/);
});

test("describeDryRun: reports the Drive destination when drive is enabled", () => {
  const config = { listFile: null, out: "o", cbz: true, drive: true, driveFolder: "FID", driveSubfolder: "Sub" };
  const lines = describeDryRun(config, [{ url: "https://x/read", name: null, status: "" }]).join("\n");
  assert.match(lines, /Drive/);
  assert.match(lines, /Sub/);
});

test("_runJobs: once stopping is set mid-job, finishes it and skips the rest", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const ran = [];
  const statuses = {};
  runner._scrapeJob = async (session, job) => {
    ran.push(job.url);
    if (job.url === "https://x/1") runner._stopping = true; // simulate Ctrl-C during job 1
    return { saved: 1, total: 1, complete: true };
  };
  const source = { hasStatus: true, setStatus: (job, v) => { statuses[job.url] = v; } };
  const jobs = [
    { url: "https://x/1", status: "", row: 1 },
    { url: "https://x/2", status: "", row: 2 }
  ];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(ran, ["https://x/1"], "job 1 finished, job 2 not started");
  assert.equal(statuses["https://x/1"], "done", "finished job's status was persisted");
});

test("_runJobs: runs every job when never stopped", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const ran = [];
  runner._scrapeJob = async (session, job) => {
    ran.push(job.url);
    return { saved: 1, total: 1, complete: true };
  };
  const source = { hasStatus: false, setStatus() {} };
  const jobs = [{ url: "https://x/1", status: "" }, { url: "https://x/2", status: "" }];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(ran, ["https://x/1", "https://x/2"]);
});

test("decideOutcome: complete when downloaded reaches total", () => {
  const o = decideOutcome({ downloaded: 50, total: 50, seeded: 0, acceptPartial: false });
  assert.deepEqual(o, { complete: true, acceptedPartial: false, stagnant: false });
});

test("decideOutcome: complete when total is unknown but pages were captured", () => {
  const o = decideOutcome({ downloaded: 12, total: 0, seeded: 0, acceptPartial: false });
  assert.equal(o.complete, true);
});

test("decideOutcome: incomplete first run with progress marks retry, not stagnant", () => {
  const o = decideOutcome({ downloaded: 49, total: 50, seeded: 0, acceptPartial: false });
  assert.deepEqual(o, { complete: false, acceptedPartial: false, stagnant: false });
});

test("decideOutcome: rerun with no new pages is stagnant; retry without the flag", () => {
  const o = decideOutcome({ downloaded: 49, total: 50, seeded: 49, acceptPartial: false });
  assert.deepEqual(o, { complete: false, acceptedPartial: false, stagnant: true });
});

test("decideOutcome: stagnant rerun with --accept-partial completes on what we have", () => {
  const o = decideOutcome({ downloaded: 49, total: 50, seeded: 49, acceptPartial: true });
  assert.deepEqual(o, { complete: true, acceptedPartial: true, stagnant: true });
});

test("decideOutcome: nothing captured is never accepted, even with the flag", () => {
  const o = decideOutcome({ downloaded: 0, total: 50, seeded: 0, acceptPartial: true });
  assert.equal(o.complete, false);
});

test("clearJobCache: removes an existing cache dir", async () => {
  const { clearJobCache } = await import("../src/pipeline.mjs");
  const { mkdtemp, writeFile, mkdir, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const base = await mkdtemp(path.join(tmpdir(), "scaper-clr-"));
  const cacheDir = path.join(base, ".scaper-cache", "job");
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path.join(cacheDir, "index.json"), "{}");
  const cleared = await clearJobCache(cacheDir, noopLogger);
  assert.equal(cleared, true);
  await assert.rejects(stat(cacheDir));
});

test("clearJobCache: no-op (returns false) when nothing is cached", async () => {
  const { clearJobCache } = await import("../src/pipeline.mjs");
  const cleared = await clearJobCache("/tmp/does-not-exist-scaper-xyz", noopLogger);
  assert.equal(cleared, false);
});

test("describeDryRun: reports the cache it would clear with --clear-cache", () => {
  const config = { listFile: null, out: "myout", cbz: true, clearCache: true };
  const lines = describeDryRun(config, [{ url: "https://x/read", name: null, status: "" }]).join("\n");
  assert.match(lines, /would clear cache/);
});
