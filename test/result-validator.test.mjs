// test/result-validator.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../src/result-validator.mjs";

const img = (n) => ({ url: `https://s/x/394/${n}-abc.jpg` });

test("success when the page count is reached", () => {
  const v = validate({ downloaded: 3, total: 3, images: [img(1), img(2), img(3)] });
  assert.equal(v.status, "success");
  assert.deepEqual(v.missing, []);
});

test("success when total is unknown but pages were captured", () => {
  const v = validate({ downloaded: 5, total: 0 });
  assert.equal(v.status, "success");
});

test("failed with EMPTY_RESULT when nothing was captured", () => {
  const v = validate({ downloaded: 0, total: 3 });
  assert.equal(v.status, "failed");
  assert.equal(v.code, "EMPTY_RESULT");
});

test("incomplete lists the missing pages", () => {
  const v = validate({ downloaded: 2, total: 3, images: [img(1), img(2)] });
  assert.equal(v.status, "incomplete");
  assert.equal(v.code, "INCOMPLETE_RESULT");
  assert.deepEqual(v.missing, [3]);
});
