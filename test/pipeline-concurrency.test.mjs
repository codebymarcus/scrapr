// Engine: the bounded row worker pool in BatchRunner._runJobs.
// At rowConcurrency 1 the behaviour matches the old sequential loop; above 1,
// up to N rows run at once, each claimed exactly once, order-preserving results.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BatchRunner } from "../src/pipeline.mjs";
import { CircuitBreaker } from "../src/breaker.mjs";
import { RecordWriter } from "../src/text/records.mjs";

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
  const { processedIds } = await runWith({ rowConcurrency: 2, jobs: 10, stopAtIndex: 2 });
  assert.ok(processedIds.length < 10, `expected fewer than 10 processed, got ${processedIds.length}`);
  assert.equal(new Set(processedIds).size, processedIds.length, "no row processed twice");
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
