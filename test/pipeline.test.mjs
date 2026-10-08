// Pipeline helpers: skip reasoning and the --dry-run preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { skipReason, describeDryRun, decideOutcome, BatchRunner, scrapeJob } from "../src/pipeline.mjs";

const noopLogger = {
  info() {}, warn() {}, muted() {}, verbose() {}, success() {}, error() {}, step() {}, section() {}, progressBar() {}
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

test("scrapeJob: on orchestrator success, packages and returns complete", async () => {
  const calls = { write: 0 };
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const packagers = [{ write: async () => { calls.write++; } }];
  const orchestrator = { run: async () => ({ status: "success", usedStrategy: "current", downloaded: 3, total: 3, attempts: [] }) };
  const r = await scrapeJob({}, { url: "https://x/read", name: "n" }, config, processor, packagers, null, noopLogger, orchestrator);
  assert.equal(r.complete, true);
  assert.equal(r.usedStrategy, "current");
  assert.equal(calls.write, 1);
});

test("scrapeJob: on orchestrator failure, returns incomplete and does not package", async () => {
  const calls = { process: 0 };
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => { calls.process++; return []; } };
  const orchestrator = { run: async () => ({ status: "failed", usedStrategy: null, downloaded: 39, total: 40, attempts: [{ name: "current", attempt: 1, status: "incomplete" }] }) };
  const r = await scrapeJob({}, { url: "https://x/read" }, config, processor, [], null, noopLogger, orchestrator);
  assert.equal(r.complete, false);
  assert.equal(r.saved, 39);
  assert.equal(calls.process, 0, "no packaging on failure");
});

test("_runJobs: resolves the profile per job and builds the right pipeline", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const seen = [];
  runner._resolveProfile = (url) => (url.includes("batcave") ? { name: "batcave", contentType: "image" } : { name: "generic", contentType: "image" });
  runner._resolvePipeline = (profile) => [{ strategy: { name: profile.name === "batcave" ? "chapter-aware" : "current" }, maxAttempts: 1 }];
  runner._scrapeJob = async (session, job, config, processor, packagers, uploader, logger, orchestrator, profile) => {
    seen.push({ url: job.url, profile: profile.name, mech: orchestrator.strategies[0].strategy.name });
    return { saved: 1, total: 1, complete: true, contentType: profile.contentType };
  };
  const source = { hasStatus: false, setStatus() {} };
  const jobs = [{ url: "https://batcave.biz/event/x/1", status: "" }, { url: "https://other.example/x", status: "" }];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(seen, [
    { url: "https://batcave.biz/event/x/1", profile: "batcave", mech: "chapter-aware" },
    { url: "https://other.example/x", profile: "generic", mech: "current" }
  ]);
});

test("_runJobs: an empty pipeline marks the row retry and continues the batch", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const statuses = {};
  const ran = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._resolvePipeline = (profile) => (profile.name === "generic" ? [] : [{ strategy: { name: "current" }, maxAttempts: 1 }]);
  runner._scrapeJob = async (s, job) => { ran.push(job.url); return { saved: 1, total: 1, complete: true }; };
  const source = { hasStatus: true, setStatus: (job, v) => { statuses[job.url] = v; } };
  const jobs = [{ url: "https://a/1", status: "", row: 1 }, { url: "https://b/2", status: "", row: 2 }];
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(ran, [], "scrapeJob not called when no mechanisms resolve");
  assert.equal(statuses["https://a/1"], "retry");
  assert.equal(statuses["https://b/2"], "retry", "batch continued to the second row");
});

test("scrapeJob: threads the profile's contentType onto the result", async () => {
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const packagers = [{ write: async () => {} }];
  const orchestrator = { run: async () => ({ status: "success", usedStrategy: "current", downloaded: 1, total: 1, attempts: [] }) };
  const r = await scrapeJob({}, { url: "https://x/read" }, config, processor, packagers, null, noopLogger, orchestrator, { name: "generic", contentType: "image" });
  assert.equal(r.complete, true);
  assert.equal(r.contentType, "image");
});

test("_runJobs: a throwing profile resolution marks the row retry and continues the batch", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0 }, noopLogger);
  const statuses = {};
  const ran = [];
  runner._resolveProfile = (url) => { if (url.includes("bad")) throw new Error("boom"); return { name: "generic", contentType: "image" }; };
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  runner._scrapeJob = async (s, job) => { ran.push(job.url); return { saved: 1, total: 1, complete: true }; };
  const source = { hasStatus: true, setStatus: (job, v) => { statuses[job.url] = v; } };
  const jobs = [{ url: "https://bad/1", status: "", row: 1 }, { url: "https://good/2", status: "", row: 2 }];
  const results = await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null });
  assert.deepEqual(ran, ["https://good/2"]);
  assert.equal(statuses["https://bad/1"], "retry");
  assert.equal(statuses["https://good/2"], "done");
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /boom/);
});

test("scrapeJob: passes profile into the orchestrator ctx", async () => {
  let ctxProfile;
  const config = { cache: false, cleanup: false, drive: false, out: "out", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const orchestrator = { run: async (ctx) => { ctxProfile = ctx.profile; return { status: "success", usedStrategy: "current", downloaded: 1, total: 1, attempts: [], metadata: null }; } };
  const profile = { name: "batcave", contentType: "image", metadata: { title: /x/ } };
  await scrapeJob({}, { url: "https://x/read" }, config, processor, [{ write: async () => {} }], null, noopLogger, orchestrator, profile);
  assert.equal(ctxProfile, profile);
});

test("scrapeJob: passes normalized metadata to the packager and auto-names from the title", async () => {
  let seenMeta, seenTargets;
  const config = { listFile: "l.csv", cache: false, cleanup: false, drive: false, out: "downloads", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const packagers = [{ write: async (_o, targets, metadata) => { seenTargets = targets; seenMeta = metadata; } }];
  const orchestrator = { run: async () => ({ status: "success", usedStrategy: "current", downloaded: 29, total: 29, attempts: [], metadata: { title: "Ultimate Hulk Annual", count: 29 } }) };
  const r = await scrapeJob({}, { url: "https://x/read", name: null }, config, processor, packagers, null, noopLogger, orchestrator, { name: "batcave", contentType: "image", metadata: {} });
  assert.equal(r.complete, true);
  assert.equal(seenMeta.series, "Ultimate Hulk Annual");
  assert.equal(seenMeta.title, "Ultimate Hulk Annual");
  assert.equal(seenMeta.pageCount, 29);
  assert.equal(seenMeta.web, "https://x/read");
  const path = (await import("node:path")).default;
  assert.equal(seenTargets.cbzPath, path.join("downloads", "Ultimate Hulk Annual.cbz"));
});

test("scrapeJob: with no extracted title, still passes pageCount+web to the packager and does not auto-name", async () => {
  let seenMeta, seenTargets;
  const config = { listFile: "l.csv", cache: false, cleanup: false, drive: false, out: "downloads", costPerGb: null };
  const processor = { process: async () => [{ name: "001.jpg", buffer: Buffer.from("x") }] };
  const packagers = [{ write: async (_o, targets, metadata) => { seenTargets = targets; seenMeta = metadata; } }];
  const orchestrator = { run: async () => ({ status: "success", usedStrategy: "current", downloaded: 7, total: 7, attempts: [], metadata: { title: null, count: null } }) };
  const job = { url: "https://x/read", name: null };
  const r = await scrapeJob({}, job, config, processor, packagers, null, noopLogger, orchestrator, { name: "batcave", contentType: "image", metadata: {} });
  assert.equal(r.complete, true);
  assert.deepEqual(seenMeta, { series: null, title: null, pageCount: 7, web: "https://x/read" });
  const { resolveTargets } = await import("../src/naming.mjs");
  assert.equal(seenTargets.cbzPath, resolveTargets(config, job).cbzPath, "falls back to the slug/sheet name, not a title");
});

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

test("_runJobs: routes a text profile to _scrapeText, image profile to _scrapeJob", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0 }, noopLogger);
  const calls = [];
  runner._resolveProfile = (url) => (url.includes("blog") ? { name: "t", contentType: "text" } : { name: "generic", contentType: "image" });
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  runner._scrapeText = async (s, job) => { calls.push(`text:${job.url}`); return { ok: true, complete: true, saved: 1, contentType: "text" }; };
  runner._scrapeJob = async (s, job) => { calls.push(`img:${job.url}`); return { complete: true, saved: 1, total: 1 }; };
  const source = { hasStatus: false, setStatus() {}, setReason() {} };
  await runner._runJobs({ jobs: [{ url: "https://blog/a", status: "" }, { url: "https://img/b", status: "" }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.deepEqual(calls, ["text:https://blog/a", "img:https://img/b"]);
});

test("_runJobs: --text (config.text) forces text mode for every URL", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0, text: true }, noopLogger);
  const calls = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._scrapeText = async (s, job) => { calls.push(job.url); return { ok: true, complete: true, saved: 1, contentType: "text" }; };
  runner._scrapeJob = async () => { throw new Error("should not be called"); };
  const source = { hasStatus: false, setStatus() {}, setReason() {} };
  await runner._runJobs({ jobs: [{ url: "https://any/x", status: "" }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.deepEqual(calls, ["https://any/x"]);
});

test("_runJobs: a text TIMEOUT failure feeds the breaker and writes the reason", async () => {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 2, text: true }, noopLogger);
  const reasons = {};
  runner._resolveProfile = () => ({ name: "t", contentType: "text" });
  runner._scrapeText = async () => ({ ok: false, complete: false, saved: 0, contentType: "text", attempts: [{ name: "text", status: "failed", code: "TIMEOUT" }] });
  const source = { hasStatus: true, setStatus() {}, setReason: (j, v) => { reasons[j.url] = v; } };
  const breaker = new CircuitBreaker(2, { base: 0 });
  const scraped = [];
  const origText = runner._scrapeText;
  runner._scrapeText = async (s, job) => { scraped.push(job.url); return origText(s, job); };
  await runner._runJobs({ jobs: [{ url: "https://d/1", status: "", row: 1 }, { url: "https://d/2", status: "", row: 2 }, { url: "https://d/3", status: "", row: 3 }], source, session: {}, processor: {}, packagers: [], uploader: null, breaker });
  assert.deepEqual(scraped, ["https://d/1", "https://d/2"], "3rd row skipped after breaker tripped on text TIMEOUTs");
  assert.equal(reasons["https://d/1"], "TIMEOUT");
});
