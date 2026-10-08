import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserKeyboardStrategy } from "../src/strategies/browser-keyboard.mjs";

const noopLogger = { info() {}, warn() {}, success() {}, error() {}, verbose() {}, debug() {} };
const fakePage = () => ({ closed: false, async close() { this.closed = true; } });
const fakeCtx = (capture, page) => ({
  session: { newPage: async () => page },
  job: { url: "https://s/x/394" },
  config: {},
  capture,
  meter: { attach() {} },
  logger: noopLogger
});

test("current: returns ok with the captured counts", async () => {
  const page = fakePage();
  const capture = { attach: async () => {}, size: 40, list: () => [] };
  const strat = new BrowserKeyboardStrategy({
    openReader: async () => {},
    ReaderDriver: class { async run() { return { total: 40 }; } }
  });
  const res = await strat.execute(fakeCtx(capture, page));
  assert.equal(res.status, "success");
  assert.deepEqual(res.data, { downloaded: 40, total: 40 });
  assert.equal(page.closed, true, "page is always closed");
});

test("current: maps a thrown timeout to a failed result", async () => {
  const page = fakePage();
  const capture = { attach: async () => {}, size: 0, list: () => [] };
  const strat = new BrowserKeyboardStrategy({
    openReader: async () => { const e = new Error("Timeout 45000ms exceeded"); e.name = "TimeoutError"; throw e; },
    ReaderDriver: class { async run() { return { total: 0 }; } }
  });
  const res = await strat.execute(fakeCtx(capture, page));
  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "TIMEOUT");
  assert.equal(page.closed, true);
});

test("current: profile params override config at execute time", async () => {
  let seenCfg;
  const strat = new BrowserKeyboardStrategy({
    params: { advanceKey: "ArrowDown", countSelector: ".x" },
    openReader: async () => {},
    ReaderDriver: class { constructor(_p, _c, cfg) { seenCfg = cfg; } async run() { return { total: 1 }; } }
  });
  const capture = { attach: async () => {}, size: 1, list: () => [] };
  const page = { async close() {} };
  await strat.execute({
    session: { newPage: async () => page }, job: { url: "u" },
    config: { advanceKey: "ArrowRight", settle: 700 }, capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(seenCfg.advanceKey, "ArrowDown", "param overrides config");
  assert.equal(seenCfg.countSelector, ".x");
  assert.equal(seenCfg.settle, 700, "non-overridden config is preserved");
});
