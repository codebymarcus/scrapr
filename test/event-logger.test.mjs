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
