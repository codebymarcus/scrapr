import { test } from "node:test";
import assert from "node:assert/strict";
import { filterImages } from "../src/recipes/image-filter.mjs";

const C = [
  { url: "https://x/hero.jpg", width: 1200, height: 800, selector: "div.reader img", index: 0 },
  { url: "https://x/logo.png", width: 88, height: 31, selector: "header img", index: 1 },
  { url: "https://x/ad.gif", width: 300, height: 250, selector: ".ad img", index: 2 },
];

test("filterImages: null/empty rules pass everything through", () => {
  assert.equal(filterImages(C, null).length, 3);
  assert.equal(filterImages(C, {}).length, 3);
});

test("filterImages: minWidth + excludeSelector keeps the hero only", () => {
  const out = filterImages(C, { minWidth: 500, excludeSelector: ".ad" });
  assert.deepEqual(out.map((c) => c.url), ["https://x/hero.jpg"]);
});

test("filterImages: rules that match nothing return []", () => {
  assert.deepEqual(filterImages(C, { minWidth: 5000 }), []);
});

test("filterImages: position range selects by index", () => {
  assert.deepEqual(filterImages(C, { position: { from: 1, to: 2 } }).map((c) => c.index), [1, 2]);
});

test("filterImages: minHeight and minBytes are numeric thresholds", () => {
  const withBytes = [
    { url: "a", width: 100, height: 100, selector: "img", index: 0, bytes: 5000 },
    { url: "b", width: 100, height: 20, selector: "img", index: 1, bytes: 90000 },
    { url: "c", width: 100, height: 100, selector: "img", index: 2, bytes: 100 },
  ];
  assert.deepEqual(filterImages(withBytes, { minHeight: 50 }).map((c) => c.url), ["a", "c"]);
  assert.deepEqual(filterImages(withBytes, { minBytes: 1000 }).map((c) => c.url), ["a", "b"]);
});

test("filterImages: includeSelector, includeUrl and excludeUrl are substring matches", () => {
  assert.deepEqual(filterImages(C, { includeSelector: "reader" }).map((c) => c.index), [0]);
  assert.deepEqual(filterImages(C, { includeUrl: ".png" }).map((c) => c.index), [1]);
  assert.deepEqual(filterImages(C, { excludeUrl: "logo" }).map((c) => c.index), [0, 2]);
});

test("filterImages: a candidate missing a numeric field fails that numeric rule", () => {
  const partial = [
    { url: "no-width", height: 800, selector: "img", index: 0 },
    { url: "has-width", width: 1200, height: 800, selector: "img", index: 1 },
  ];
  assert.deepEqual(filterImages(partial, { minWidth: 500 }).map((c) => c.url), ["has-width"]);
  assert.deepEqual(filterImages(partial, { minBytes: 1 }), []);
});

test("filterImages: a missing numeric field does not affect rules that do not reference it", () => {
  const partial = [{ url: "no-bytes", width: 1200, height: 800, selector: "img", index: 0 }];
  assert.deepEqual(filterImages(partial, { minWidth: 500 }).map((c) => c.url), ["no-bytes"]);
});

test("filterImages: rules are ANDed", () => {
  assert.deepEqual(filterImages(C, { minWidth: 100, minHeight: 300 }).map((c) => c.index), [0]);
});
