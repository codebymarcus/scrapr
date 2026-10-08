// test/breaker.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, DOMAIN_HEALTH_CODES, hostOf, failureCodeOf } from "../src/breaker.mjs";

test("hostOf: hostname from a URL; raw string on a bad URL", () => {
  assert.equal(hostOf("https://BatCave.biz/event/x/1"), "batcave.biz");
  assert.equal(hostOf("not a url"), "not a url");
});

test("failureCodeOf: ok → null; exception → mapped; attempts → last code; empty → UNKNOWN", () => {
  assert.equal(failureCodeOf({ ok: true }), null);
  assert.equal(failureCodeOf({ ok: false, error: "net::ERR_CONNECTION_RESET" }), "NETWORK_ERROR");
  assert.equal(failureCodeOf({ ok: false, attempts: [{ code: "TIMEOUT" }, { code: "RATE_LIMITED" }] }), "RATE_LIMITED");
  assert.equal(failureCodeOf({ ok: false }), "UNKNOWN_ERROR");
});

test("record/isTripped: increments only on domain-health codes, trips at threshold", () => {
  const b = new CircuitBreaker(3, { base: 1000, cap: 10000 });
  b.record("h", { ok: false, code: "RATE_LIMITED" });
  b.record("h", { ok: false, code: "INCOMPLETE_RESULT" }); // content: ignored
  b.record("h", { ok: false, code: "BLOCKED" });
  assert.equal(b.isTripped("h"), false, "2 health failures < threshold");
  b.record("h", { ok: false, code: "TIMEOUT" });
  assert.equal(b.isTripped("h"), true, "3rd health failure trips");
});

test("record: a success resets the counter (domain recovered)", () => {
  const b = new CircuitBreaker(2, { base: 1000 });
  b.record("h", { ok: false, code: "BLOCKED" });
  b.record("h", { ok: true });
  b.record("h", { ok: false, code: "BLOCKED" });
  assert.equal(b.isTripped("h"), false, "counter reset by the success in between");
});

test("record: a success clears the tripped status (tripped host recovered)", () => {
  const b = new CircuitBreaker(2, { base: 1000 });
  b.record("h", { ok: false, code: "BLOCKED" });
  b.record("h", { ok: false, code: "BLOCKED" });
  assert.equal(b.isTripped("h"), true);
  b.record("h", { ok: true });
  assert.equal(b.isTripped("h"), false);
  assert.equal(b.extraDelay("h"), 0);
});

test("extraDelay: 0 when healthy; escalates base·2^(n-1) capped at cap; resets on success", () => {
  const b = new CircuitBreaker(5, { base: 1000, cap: 4000 });
  assert.equal(b.extraDelay("h"), 0);
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=1
  assert.equal(b.extraDelay("h"), 1000);
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=2
  assert.equal(b.extraDelay("h"), 2000);
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=3 → 4000
  b.record("h", { ok: false, code: "RATE_LIMITED" }); // n=4 → 8000 capped to 4000
  assert.equal(b.extraDelay("h"), 4000);
  b.record("h", { ok: true });
  assert.equal(b.extraDelay("h"), 0);
});

test("threshold 0 disables: never trips, no backoff", () => {
  const b = new CircuitBreaker(0, { base: 1000 });
  for (let i = 0; i < 10; i++) b.record("h", { ok: false, code: "BLOCKED" });
  assert.equal(b.isTripped("h"), false);
  assert.equal(b.extraDelay("h"), 0);
  assert.equal(b.enabled(), false);
});
