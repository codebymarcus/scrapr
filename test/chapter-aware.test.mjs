import { test } from "node:test";
import assert from "node:assert/strict";
import { ChapterAwareStrategy, sameIssue } from "../src/strategies/chapter-aware.mjs";

const noopLogger = { info() {}, warn() {}, success() {}, error() {}, verbose() {}, debug() {}, progressBar() {} };

test("sameIssue: same chapter path (differing hash/query) is the same issue", () => {
  assert.equal(sameIssue("https://batcave.biz/event/ultimate-marvel/394", "https://batcave.biz/event/ultimate-marvel/394#p=5"), true);
  assert.equal(sameIssue("https://batcave.biz/event/ultimate-marvel/394", "https://batcave.biz/event/ultimate-marvel/394?page=5"), true);
});

test("sameIssue: the next-chapter jump (394 → 395) is a DIFFERENT issue", () => {
  assert.equal(sameIssue("https://batcave.biz/event/ultimate-marvel/394", "https://batcave.biz/event/ultimate-marvel/395"), false);
});

// A controllable fake reader page. capture.size grows one per press (page 1 is
// already loaded on open), simulating pages rendering as we advance.
function fakeReader({ total, jumpAtPress = null }) {
  let presses = 0;
  let url = "https://batcave.biz/event/ultimate-marvel/394";
  const page = {
    _presses: () => presses,
    url: () => url,
    async evaluate() { return total; },       // detectTotal count
    mouse: { click: async () => {} },
    keyboard: { press: async () => { presses++; if (jumpAtPress && presses >= jumpAtPress) url = "https://batcave.biz/event/ultimate-marvel/395"; } },
    async waitForTimeout() {},
    closed: false,
    async close() { this.closed = true; }
  };
  const capture = { attach: async () => {}, takeBackoff: () => 0, list: () => [], get size() { return Math.min(presses + 1, total); } };
  return { page, capture };
}

test("chapter-aware: accurate total → reaches the last page without jumping", async () => {
  const { page, capture } = fakeReader({ total: 5, jumpAtPress: null });
  let recovered = false;
  const strat = new ChapterAwareStrategy({
    openReader: async () => {},
    navigateWithRetry: async () => { recovered = true; }
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: page.url() }, config: { settle: 10, jitter: 0 },
    capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(res.status, "success");
  assert.equal(res.data.downloaded, 5);
  assert.equal(recovered, false, "no recovery needed when total is accurate");
});

test("chapter-aware: over-detected total → detects the jump, recovers, returns what it has", async () => {
  const { page, capture } = fakeReader({ total: 6, jumpAtPress: 3 });
  let recovered = false;
  const strat = new ChapterAwareStrategy({
    openReader: async () => {},
    navigateWithRetry: async () => { recovered = true; }
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: "https://batcave.biz/event/ultimate-marvel/394" },
    config: { settle: 10, jitter: 0 }, capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(recovered, true, "recovery ran on the detected jump");
  assert.ok(res.data.downloaded > 0, "keeps the pages captured before the jump");
  assert.equal(page.closed, true);
});

test("chapter-aware: zero pages captured, no jump → failed EMPTY_RESULT", async () => {
  const { page, capture } = fakeReader({ total: 0, jumpAtPress: null });
  const strat = new ChapterAwareStrategy({
    openReader: async () => {},
    navigateWithRetry: async () => {}
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: page.url() }, config: { settle: 10, jitter: 0 },
    capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "EMPTY_RESULT");
});

test("chapter-aware: zero pages captured AND a jump → failed NAVIGATION_JUMP", async () => {
  const { page, capture } = fakeReader({ total: 0, jumpAtPress: 2 });
  let recovered = false;
  const strat = new ChapterAwareStrategy({
    openReader: async () => {},
    navigateWithRetry: async () => { recovered = true; }
  });
  const res = await strat.execute({
    session: { newPage: async () => page }, job: { url: "https://batcave.biz/event/ultimate-marvel/394" },
    config: { settle: 10, jitter: 0 }, capture, meter: { attach() {} }, logger: noopLogger
  });
  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "NAVIGATION_JUMP");
  assert.equal(recovered, true, "recovery still runs even though nothing was captured");
});
