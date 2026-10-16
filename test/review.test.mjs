import { test } from "node:test";
import assert from "node:assert/strict";
import { needsReview } from "../src/recipes/review.mjs";

test("needsReview: complete but zero saved is flagged", () => {
  assert.equal(needsReview({ complete: true, saved: 0 }, { contentType: "text" }), true);
  assert.equal(needsReview({ complete: true, saved: 3 }, { contentType: "text" }), false);
});

test("needsReview: image count mismatch when expectCount set", () => {
  assert.equal(needsReview({ complete: true, saved: 10, total: 10 }, { image: { expectCount: 12 } }), true);
  assert.equal(needsReview({ complete: true, saved: 12, total: 12 }, { image: { expectCount: 12 } }), false);
});

test("needsReview: a failed job is not 'needs review' (it's a retry)", () => {
  assert.equal(needsReview({ complete: false, saved: 0 }, { contentType: "image" }), false);
});
