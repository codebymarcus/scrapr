// Engine: the bounded row worker pool in BatchRunner._runJobs.
// At rowConcurrency 1 the behaviour matches the old sequential loop; above 1,
// up to N rows run at once, each claimed exactly once, order-preserving results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchRunner } from "../src/pipeline.mjs";
import { CircuitBreaker } from "../src/breaker.mjs";
import { RecordWriter } from "../src/text/records.mjs";
import { createRowLimiter } from "../dashboard/server/src/row-limiter.mjs";

const noopLogger = {
  info() {}, warn() {}, muted() {}, verbose() {}, success() {}, error() {}, step() {}, section() {}, progressBar() {}
};

const tick = () => new Promise((r) => setImmediate(r));

function makeJobs(n) {
  return Array.from({ length: n }, (_, i) => ({ url: `https://x/${i}`, status: "", row: i + 1, _id: i }));
}

// Drive _runJobs with an injected barrier _scrapeJob that records the maximum
// number of rows observed in flight at once, plus the start order and ids seen.
async function runWith({ rowConcurrency, jobs: n, stopAtIndex }) {
  const runner = new BatchRunner({ itemDelay: 0, jitter: 0, maxDomainFailures: 0, rowConcurrency }, noopLogger);
  let inFlight = 0, maxInFlight = 0;
  const order = [];
  const processedIds = [];
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  runner._scrapeJob = async (session, job) => {
    const idx = job._id;
    if (stopAtIndex !== undefined && idx === stopAtIndex) runner.stop();
    order.push(idx);
    processedIds.push(idx);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(); // yield so other workers can start — overlap becomes observable
    inFlight--;
    return { saved: 1, total: 1, complete: true };
  };
  const statuses = {};
  const source = { hasStatus: true, setStatus: (j, v) => { statuses[j.url] = v; }, setReason() {} };
  const jobs = makeJobs(n);
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  return { maxInFlight, order, processedIds, statuses };
}

test("rowConcurrency=1 processes rows one at a time, in order", async () => {
  const { maxInFlight, order } = await runWith({ rowConcurrency: 1, jobs: 5 });
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test("rowConcurrency=3 runs up to 3 rows at once and processes each exactly once", async () => {
  const { maxInFlight, processedIds } = await runWith({ rowConcurrency: 3, jobs: 9 });
  assert.equal(maxInFlight, 3);
  assert.equal(processedIds.length, 9);
  assert.equal(new Set(processedIds).size, 9); // none double-claimed, none missed
});

test("stop mid-run: in-flight finish, remaining rows left unprocessed", async () => {
  const { processedIds, statuses } = await runWith({ rowConcurrency: 2, jobs: 10, stopAtIndex: 2 });
  assert.ok(processedIds.length < 10, `expected fewer than 10 processed, got ${processedIds.length}`);
  assert.equal(new Set(processedIds).size, processedIds.length, "no row processed twice");
  // Unclaimed rows stay resumable: only processed rows touched the status store, so
  // the never-claimed rows keep their blank status (nothing marked done/retry).
  assert.equal(Object.keys(statuses).length, processedIds.length, "only processed rows wrote a status");
});

// Build a runner wired to scrape via an injected barrier _scrapeJob that shares an
// in-flight counter, so two runners can be driven against ONE limiter and we can
// observe the real max overlap across both.
function makeLimiterRunner({ rowConcurrency, rowLimiter, shared }) {
  const runner = new BatchRunner(
    { itemDelay: 0, jitter: 0, maxDomainFailures: 0, rowConcurrency },
    noopLogger,
    { rowLimiter }
  );
  runner._resolveProfile = () => ({ name: "generic", contentType: "image" });
  runner._resolvePipeline = () => [{ strategy: { name: "current" }, maxAttempts: 1 }];
  runner._scrapeJob = async (session, job) => {
    if (job._throw) throw new Error("boom");
    shared.inFlight++;
    shared.maxInFlight = Math.max(shared.maxInFlight, shared.inFlight);
    await tick();
    await tick();
    shared.inFlight--;
    return { saved: 1, total: 1, complete: true };
  };
  return runner;
}

test("a shared limiter bounds total concurrent scrapes across two runners", async () => {
  const lim = createRowLimiter(2);
  const shared = { inFlight: 0, maxInFlight: 0 };
  const source = () => ({ hasStatus: true, setStatus() {}, setReason() {} });
  const ctx = { processor: {}, packagers: [], uploader: null };

  const runnerA = makeLimiterRunner({ rowConcurrency: 3, rowLimiter: lim, shared });
  const runnerB = makeLimiterRunner({ rowConcurrency: 3, rowLimiter: lim, shared });

  await Promise.all([
    runnerA._runJobs({ jobs: makeJobs(6), source: source(), session: {}, ...ctx, breaker: new CircuitBreaker(0) }),
    runnerB._runJobs({ jobs: makeJobs(6), source: source(), session: {}, ...ctx, breaker: new CircuitBreaker(0) }),
  ]);

  // Each runner would allow 3 rows at once (6 total), but the shared max-2 limiter
  // caps the real overlap across BOTH runners.
  assert.equal(shared.maxInFlight, 2);
  assert.equal(lim.inUse(), 0, "all slots released after both runs finish");
});

test("a row that throws still releases its slot (no leak)", async () => {
  const lim = createRowLimiter(2);
  const shared = { inFlight: 0, maxInFlight: 0 };
  const runner = makeLimiterRunner({ rowConcurrency: 2, rowLimiter: lim, shared });
  const jobs = makeJobs(4);
  jobs[1]._throw = true; // one row's scrape throws
  const source = { hasStatus: true, setStatus() {}, setReason() {} };
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.equal(lim.inUse(), 0, "slot released even when the scrape throws");
});

test("concurrent text-record appends are serialized (no lost records, no overlapping writes)", async () => {
  const runner = new BatchRunner(
    { itemDelay: 0, jitter: 0, maxDomainFailures: 0, text: true, textMode: "pattern", rowConcurrency: 4 },
    noopLogger
  );
  // Real RecordWriter, but its file writes are stubbed and instrumented to detect
  // overlap. Serialized appends must never have two writes active at the same time.
  let activeWrites = 0, maxActiveWrites = 0;
  const writer = new RecordWriter("base", {
    writeFile: async () => {
      activeWrites++;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      await tick();
      activeWrites--;
    }
  });
  runner._recordWriter = writer;
  runner._resolveProfile = () => ({ name: "generic", contentType: "text" });
  runner._scrapeText = async (session, job, config, logger, profile, deps) => {
    await deps.recordWriter.append({ url: job.url, email: ["a@b"] });
    return { ok: true, complete: true, saved: 1, contentType: "text", via: "http" };
  };
  const source = { hasStatus: false, setStatus() {}, setReason() {} };
  const jobs = makeJobs(20);
  await runner._runJobs({ jobs, source, session: {}, processor: {}, packagers: [], uploader: null, breaker: new CircuitBreaker(0) });
  assert.equal(writer.count, 20, "every row's record was appended");
  assert.equal(maxActiveWrites, 1, "record writes never overlapped");
});

test("a failing record append rejects to its caller but does not poison later rows", async () => {
  const runner = new BatchRunner(
    { itemDelay: 0, jitter: 0, maxDomainFailures: 0, text: true, textMode: "pattern", rowConcurrency: 1 },
    noopLogger
  );
  // RecordWriter whose file write rejects exactly once (the first flush), then succeeds.
  let calls = 0;
  const written = [];
  const writer = new RecordWriter("base", {
    writeFile: async (pathArg, data) => {
      calls++;
      if (calls === 1) throw new Error("ENOSPC: disk full");
      if (pathArg.endsWith(".json")) written.push(data);
    }
  });
  runner._recordWriter = writer;
  const sw = runner._serialRecordWriter();

  // Row A's append rejects (caller must see the error) ...
  await assert.rejects(sw.append({ url: "https://x/a", v: 1 }), /disk full/, "failing row surfaces its error");
  // ... but the chain is not poisoned: row B's append still runs and is written.
  await sw.append({ url: "https://x/b", v: 2 });

  // Row A pushed its record before the (failed) flush; row B's record is present too.
  assert.equal(writer.count, 2, "both records are in the writer; B was not skipped");
  const last = JSON.parse(written[written.length - 1]);
  assert.deepEqual(last.map((r) => r.url), ["https://x/a", "https://x/b"], "B's successful flush wrote both rows");
});
