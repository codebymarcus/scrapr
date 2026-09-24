// Timing helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withJitter } from "../src/time.mjs";

test("withJitter: zero jitter returns the base value", () => {
  assert.equal(withJitter(1000, 0), 1000);
});

test("withJitter: stays within +/- jitter of the base", () => {
  for (let i = 0; i < 500; i++) {
    const v = withJitter(1000, 0.3);
    assert.ok(v >= 700 && v <= 1300, `out of range: ${v}`);
  }
});

test("withJitter: returns an integer", () => {
  assert.equal(Number.isInteger(withJitter(1234, 0.5)), true);
});
