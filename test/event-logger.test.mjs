// Event logger: structured events to an injected emit callback, tee to base.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventLogger } from "../src/events/event-logger.mjs";

test("createEventLogger emits structured events and tees to base", () => {
  const events = []; const based = [];
  const base = { info: (m) => based.push(m), progressBar() {}, debug() {} };
  const log = createEventLogger((e) => events.push(e), base);
  log.info("hello");
  log.progressBar(3, 10, "pages");
  assert.equal(events[0].type, "log");
  assert.equal(events[0].level, "info");
  assert.equal(events[0].message, "hello");
  assert.deepEqual([events[1].type, events[1].current, events[1].total], ["progress", 3, 10]);
  assert.deepEqual(based, ["hello"]);
});

test("createEventLogger swallows a throwing emit so scraping is never broken", () => {
  const log = createEventLogger(() => { throw new Error("ws down"); }, null);
  assert.doesNotThrow(() => log.error("boom"));
});

test("forItem stamps progress events with the item id", () => {
  const events = [];
  const log = createEventLogger((e) => events.push(e));
  log.forItem(42).progressBar(3, 10, "pages");
  log.forItem(42).endProgress();
  assert.deepEqual(events[0], { type: "progress", itemId: 42, current: 3, total: 10, label: "pages", ts: events[0].ts });
  assert.equal(events[1].type, "progress-end");
  assert.equal(events[1].itemId, 42);
});

test("forItem delegates text methods unchanged and tees progress to base", () => {
  const events = []; const calls = [];
  const base = { info: (m) => calls.push(["info", m]), progressBar: (...a) => calls.push(["progressBar", ...a]), endProgress: () => calls.push(["endProgress"]) };
  const log = createEventLogger((e) => events.push(e), base);
  const row = log.forItem(7);
  row.info("hi");
  row.progressBar(1, 2, "pages");
  row.endProgress();
  assert.equal(events[0].itemId, undefined);
  assert.equal(events[0].message, "hi");
  assert.deepEqual(calls, [["info", "hi"], ["progressBar", 1, 2, "pages"], ["endProgress"]]);
});
