// chapter-aware strategy: addresses a continuous/looping reader's target chapter
// directly by #page-N fragment (batcave.biz), instead of pressing ArrowRight
// through adjacent chapters. Tested with fakes, no real browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChapterAwareStrategy, imageDir } from "../src/strategies/chapter-aware.mjs";

const noopLogger = { info() {}, warn() {}, success() {}, error() {}, verbose() {}, debug() {}, progressBar() {} };

// A fake capture that grows when a page is "loaded". `flaky` is a set of page
// indices that fail on their first visit and succeed on a later one.
function fakeCapture({ start = 0, flaky = new Set() } = {}) {
  const seenPages = new Set();
  const attempted = new Map();
  const cap = {
    _size: start,
    locked: null,
    get size() { return this._size; },
    async attach() {},
    list: () => [],
    takeBackoff: () => 0,
    lockIssueDir(dir) { this.locked = dir; },
    // called by the test's gotoPage fake to simulate a page's image loading
    _load(n) {
      const tries = (attempted.get(n) || 0) + 1;
      attempted.set(n, tries);
      if (seenPages.has(n)) return;              // already captured → no new image
      if (flaky.has(n) && tries < 2) return;     // transient miss on first visit
      seenPages.add(n);
      this._size++;
    }
  };
  return cap;
}

function fakePage() {
  return { closed: false, mouse: { click: async () => {} }, async waitForTimeout() {}, async close() { this.closed = true; }, url: () => "https://batcave.biz/event/ultimate-marvel/395" };
}

// Build a strategy with the browser-touching seams stubbed for the test.
function strategyFor(capture, { total = 5, dir = "https://img.batcave.biz/img/30378/213188/", visited } = {}) {
  const s = new ChapterAwareStrategy({ openReader: async () => {} });
  s.detectTotal = async () => total;
  s.readTargetDir = async () => dir;
  s.gotoPage = async (_page, n) => { visited?.push(n); capture._load(n); };
  return s;
}

const ctxFor = (capture, page) => ({
  session: { newPage: async () => page },
  job: { url: "https://batcave.biz/event/ultimate-marvel/395" },
  config: { settle: 1, jitter: 0 },
  capture,
  meter: { attach() {} },
  logger: noopLogger
});

test("imageDir: derives the directory from an image URL", () => {
  assert.equal(imageDir("https://img.batcave.biz/img/30378/213188/1785_0000_ab.jpg"), "https://img.batcave.biz/img/30378/213188/");
  assert.equal(imageDir(""), null);
  assert.equal(imageDir(null), null);
});

test("addresses every page by fragment and completes", async () => {
  const capture = fakeCapture();
  const page = fakePage();
  const visited = [];
  const s = strategyFor(capture, { total: 5, visited });
  const res = await s.execute(ctxFor(capture, page));
  assert.equal(res.status, "success");
  assert.equal(res.data.downloaded, 5);
  assert.equal(res.data.total, 5);
  assert.deepEqual(visited, [1, 2, 3, 4, 5], "visited pages 1..N in order");
  assert.equal(page.closed, true);
});

test("locks the capture onto the target chapter's image directory", async () => {
  const capture = fakeCapture();
  const s = strategyFor(capture, { total: 3, dir: "https://img.batcave.biz/img/30378/213188/" });
  await s.execute(ctxFor(capture, fakePage()));
  assert.equal(capture.locked, "https://img.batcave.biz/img/30378/213188/");
});

test("re-visits a page that missed on the first pass", async () => {
  const capture = fakeCapture({ flaky: new Set([3]) });
  const visited = [];
  const s = strategyFor(capture, { total: 5, visited });
  const res = await s.execute(ctxFor(capture, fakePage()));
  assert.equal(res.status, "success");
  assert.equal(res.data.downloaded, 5, "all pages captured after the retry pass");
  assert.equal(visited.filter((n) => n === 3).length, 2, "page 3 was revisited");
});

test("fails with EMPTY_RESULT when nothing loads", async () => {
  const capture = fakeCapture();
  const s = new ChapterAwareStrategy({ openReader: async () => {} });
  s.detectTotal = async () => 4;
  s.readTargetDir = async () => "https://img/x/dir/";
  s.gotoPage = async () => {}; // never loads anything
  const res = await s.execute(ctxFor(capture, fakePage()));
  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "EMPTY_RESULT");
});

test("maps a thrown error from openReader to a failed result", async () => {
  const capture = fakeCapture();
  const page = fakePage();
  const s = new ChapterAwareStrategy({ openReader: async () => { const e = new Error("Timeout 45000ms exceeded"); e.name = "TimeoutError"; throw e; } });
  const res = await s.execute(ctxFor(capture, page));
  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "TIMEOUT");
  assert.equal(page.closed, true);
});

test("chapter-aware: profile params override config at execute time", async () => {
  let seenCfg;
  const strat = new ChapterAwareStrategy({ params: { settle: 50 }, openReader: async (_p, _u, cfg) => { seenCfg = cfg; } });
  strat.detectTotal = async () => 0; // short-circuit the page loop
  const capture = fakeCapture();
  await strat.execute({
    session: { newPage: async () => fakePage() }, job: { url: "u" },
    config: { settle: 3000, jitter: 0 }, capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(seenCfg.settle, 50, "param overrides config");
});

test("chapter-aware: returns extracted metadata in the success result", async () => {
  const capture = fakeCapture();
  const visited = [];
  const s = strategyFor(capture, { total: 2, visited });
  s.extractMetadata = async () => ({ title: "Hulk", count: 2 });
  const res = await s.execute({ ...ctxFor(capture, fakePage()), profile: { metadata: {} } });
  assert.equal(res.status, "success");
  assert.deepEqual(res.data.metadata, { title: "Hulk", count: 2 });
});
