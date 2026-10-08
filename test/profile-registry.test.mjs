import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProfile, resolvePipeline } from "../src/profiles/registry.mjs";

const capturingLogger = () => { const warns = []; return { warn: (m) => warns.push(m), warns }; };
// Fake mechanisms so resolution is tested without constructing real strategies.
const fakeMechs = {
  current: (params) => ({ name: "current", defaultMaxAttempts: 2, params }),
  "chapter-aware": (params) => ({ name: "chapter-aware", defaultMaxAttempts: 1, params })
};

test("resolveProfile: batcave URL → batcave, others → generic, bad URL → generic", () => {
  assert.equal(resolveProfile("https://batcave.biz/event/x/1").name, "batcave");
  assert.equal(resolveProfile("https://example.com/x").name, "generic");
  assert.equal(resolveProfile("not a url").name, "generic");
});

test("resolvePipeline: batcave → [chapter-aware x1], generic → [current x2]", () => {
  const bc = resolveProfile("https://batcave.biz/x/1");
  const rb = resolvePipeline(bc, {}, capturingLogger(), fakeMechs);
  assert.deepEqual(rb.map((x) => x.strategy.name), ["chapter-aware"]);
  assert.equal(rb[0].maxAttempts, 1);
  const gen = resolveProfile("https://example.com/x");
  const rg = resolvePipeline(gen, {}, capturingLogger(), fakeMechs);
  assert.deepEqual(rg.map((x) => x.strategy.name), ["current"]);
  assert.equal(rg[0].maxAttempts, 2);
});

test("resolvePipeline: passes params into the mechanism", () => {
  const profile = { pipeline: [{ mechanism: "current", params: { advanceKey: "ArrowDown" } }] };
  const r = resolvePipeline(profile, {}, capturingLogger(), fakeMechs);
  assert.deepEqual(r[0].strategy.params, { advanceKey: "ArrowDown" });
});

test("resolvePipeline: config.strategies overrides the profile pipeline globally", () => {
  const profile = { pipeline: [{ mechanism: "chapter-aware" }] };
  const r = resolvePipeline(profile, { strategies: [{ name: "current", maxAttempts: 1 }] }, capturingLogger(), fakeMechs);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.equal(r[0].maxAttempts, 1);
});

test("resolvePipeline: unknown mechanism is warned and skipped", () => {
  const log = capturingLogger();
  const profile = { pipeline: [{ mechanism: "nope" }, { mechanism: "current" }] };
  const r = resolvePipeline(profile, {}, log, fakeMechs);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.some((m) => /unknown mechanism "nope"/.test(m)));
});

test("resolvePipeline: maxAttempts:0 and enabled:false disable an entry", () => {
  const profile = { pipeline: [{ mechanism: "current", maxAttempts: 0 }, { mechanism: "chapter-aware", enabled: false }] };
  const r = resolvePipeline(profile, {}, capturingLogger(), fakeMechs);
  assert.equal(r.length, 0);
});

test("resolvePipeline: invalid entries are warned and skipped", () => {
  const log = capturingLogger();
  const profile = { pipeline: [null, { maxAttempts: 2 }, { mechanism: "current" }] };
  const r = resolvePipeline(profile, {}, log, fakeMechs);
  assert.deepEqual(r.map((x) => x.strategy.name), ["current"]);
  assert.ok(log.warns.length >= 2);
});
