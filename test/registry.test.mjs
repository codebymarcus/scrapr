// Strategy registry: configuration → ordered pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStrategies, DEFAULT_PIPELINE } from "../src/strategies/registry.mjs";

const capturingLogger = () => { const warns = []; return { warn: (m) => warns.push(m), warns }; };
// Cheap fake factories so registry logic is tested in isolation from strategies.
const factories = {
  current: () => ({ name: "current", defaultMaxAttempts: 2 }),
  "chapter-aware": () => ({ name: "chapter-aware", defaultMaxAttempts: 1 })
};

test("null strategies → the default pipeline, in order", () => {
  const r = resolveStrategies({ strategies: null }, capturingLogger(), factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current", "chapter-aware"]);
  assert.deepEqual(r.map((x) => x.maxAttempts), [2, 1]);
});

test("DEFAULT_PIPELINE matches the spec order and attempts", () => {
  assert.deepEqual(DEFAULT_PIPELINE, [{ name: "current", maxAttempts: 2 }, { name: "chapter-aware", maxAttempts: 1 }]);
});

test("enabled:false entries are skipped", () => {
  const r = resolveStrategies({ strategies: [{ name: "current", enabled: false }, { name: "chapter-aware" }] }, capturingLogger(), factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["chapter-aware"]);
  assert.equal(r[0].maxAttempts, 1, "falls back to defaultMaxAttempts");
});

test("maxAttempts:0 disables a strategy", () => {
  const r = resolveStrategies({ strategies: [{ name: "current", maxAttempts: 0 }] }, capturingLogger(), factories);
  assert.equal(r.length, 0);
});

test("unknown strategy name is warned and skipped", () => {
  const log = capturingLogger();
  const r = resolveStrategies({ strategies: [{ name: "nope" }, { name: "current" }] }, log, factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.some((m) => /unknown strategy "nope"/.test(m)));
});

test("invalid entries are warned and skipped", () => {
  const log = capturingLogger();
  const r = resolveStrategies({ strategies: [null, { maxAttempts: 2 }, { name: "current" }] }, log, factories);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.length >= 2);
});
