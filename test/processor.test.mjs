// Image ordering: page-number parsing and stable ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageNumberFromUrl, orderImages, ImageProcessor } from "../src/processor.mjs";

function spyLogger() {
  const warnings = [];
  return {
    warnings,
    info() {}, muted() {}, success() {}, error() {}, step() {}, progressBar() {},
    warn(m) { warnings.push(m); }
  };
}

const img = (url, seq) => ({ url, seq, contentType: "image/jpeg", buffer: Buffer.alloc(1) });

test("pageNumberFromUrl: parses '<n>-<hash>.<ext>' page numbers", () => {
  assert.equal(pageNumberFromUrl("https://cdn.x/39131/4-abc123.jpg"), 4);
  assert.equal(pageNumberFromUrl("https://cdn.x/39131/12-deadbeef.webp?x=1"), 12);
});

test("process: fails the item when a page has an empty buffer (failed capture)", async () => {
  const proc = new ImageProcessor({ format: "jpg", quality: 80, maxEdge: 2400 }, spyLogger());
  const pages = [
    { url: "https://cdn.x/1-a.jpg", seq: 0, contentType: "image/jpeg", buffer: Buffer.alloc(50) },
    { url: "https://cdn.x/2-b.jpg", seq: 1, contentType: "image/jpeg", buffer: Buffer.alloc(0) }
  ];
  await assert.rejects(() => proc.process(pages), /page 2 .*empty/i);
});

test("pageNumberFromUrl: parses batcave '<ts>_<index>_<hash>.<ext>' (0-based → 1-based)", () => {
  assert.equal(pageNumberFromUrl("https://img.batcave.biz/img/30378/213188/1785660934_0000_9f7bcd.jpg"), 1);
  assert.equal(pageNumberFromUrl("https://img.batcave.biz/img/30378/213188/1785660940_0028_0e847c.jpg"), 29);
});

test("pageNumberFromUrl: returns null when no page number present", () => {
  assert.equal(pageNumberFromUrl("https://cdn.x/cover.jpg"), null);
  assert.equal(pageNumberFromUrl("https://cdn.x/some/path/"), null);
});

test("orderImages: sorts numbered pages ascending by page number", () => {
  const imgs = [
    { url: "https://cdn.x/i/3-h.jpg" },
    { url: "https://cdn.x/i/1-h.jpg" },
    { url: "https://cdn.x/i/2-h.jpg" }
  ];
  const ordered = orderImages(imgs);
  assert.deepEqual(ordered.map((e) => e.page), [1, 2, 3]);
});

test("orderImages: numbered pages come before unnumbered ones", () => {
  const imgs = [
    { url: "https://cdn.x/i/logo.png" },
    { url: "https://cdn.x/i/2-h.jpg" },
    { url: "https://cdn.x/i/1-h.jpg" }
  ];
  const ordered = orderImages(imgs);
  assert.deepEqual(ordered.map((e) => e.page), [1, 2, null]);
});

test("orderImages: unnumbered pages are ordered by capture seq, not array position", () => {
  // Arrival order (array) is scrambled; seq reflects the true capture order.
  const imgs = [
    { url: "https://cdn.x/a.png", seq: 2 },
    { url: "https://cdn.x/b.png", seq: 0 },
    { url: "https://cdn.x/c.png", seq: 1 }
  ];
  const ordered = orderImages(imgs);
  assert.deepEqual(ordered.map((e) => e.url), [
    "https://cdn.x/b.png",
    "https://cdn.x/c.png",
    "https://cdn.x/a.png"
  ]);
});

test("process: warns when most pages have no parseable page number", async () => {
  const logger = spyLogger();
  const proc = new ImageProcessor({ format: "keep" }, logger);
  await proc.process([img("https://x/a.jpg", 0), img("https://x/b.jpg", 1), img("https://x/1-h.jpg", 2)]);
  assert.equal(logger.warnings.some((w) => /order/i.test(w)), true, "expected an ordering warning");
});

test("process: does not warn when every page is numbered", async () => {
  const logger = spyLogger();
  const proc = new ImageProcessor({ format: "keep" }, logger);
  await proc.process([img("https://x/1-h.jpg", 0), img("https://x/2-h.jpg", 1)]);
  assert.equal(logger.warnings.some((w) => /order/i.test(w)), false);
});

test("missingPages: reports which numbered pages are absent up to total", async () => {
  const { missingPages } = await import("../src/processor.mjs");
  const imgs = [1,2,3,5,6].map((n) => ({ url: `https://x/i/${n}-h.jpg` }));
  assert.deepEqual(missingPages(imgs, 7), [4, 7]);
});

test("missingPages: none missing when all present", async () => {
  const { missingPages } = await import("../src/processor.mjs");
  const imgs = [1,2,3].map((n) => ({ url: `https://x/i/${n}-h.jpg` }));
  assert.deepEqual(missingPages(imgs, 3), []);
});

test("missingPages: empty when total is unknown", async () => {
  const { missingPages } = await import("../src/processor.mjs");
  assert.deepEqual(missingPages([{ url: "https://x/i/1-h.jpg" }], 0), []);
});

test("formatPageList: compresses consecutive runs into ranges", async () => {
  const { formatPageList } = await import("../src/processor.mjs");
  assert.equal(formatPageList([14]), "14");
  assert.equal(formatPageList([2,3,4,7,9,10]), "2-4, 7, 9-10");
  assert.equal(formatPageList([]), "");
});
