import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCandidateImages, imagePreview } from "../src/preview/image-preview.mjs";

const noopLogger = { info() {}, warn() {}, muted() {}, success() {}, error() {}, step() {}, progressBar() {} };

test("collectCandidateImages returns descriptors from the page", async () => {
  const page = { async evaluate() { return [
    { url: "https://x/1.jpg", width: 1200, height: 800, selector: "div.reader > img:nth-child(1)", index: 0 },
    { url: "https://x/logo.png", width: 88, height: 31, selector: "header img", index: 1 }
  ]; } };
  const out = await collectCandidateImages(page);
  assert.equal(out.length, 2);
  assert.equal(out[0].width, 1200);
});

test("collectCandidateImages returns [] on a page with no images", async () => {
  const page = { async evaluate() { return []; } };
  assert.deepEqual(await collectCandidateImages(page), []);
});

test("imagePreview opens, collects, and closes the page; failure is non-throwing", async () => {
  let closed = false;
  const page = { async evaluate() { return [{ url: "https://x/1.jpg", width: 10, height: 10, selector: "img", index: 0 }]; },
                 async close() { closed = true; } };
  const session = { async newPage() { return page; } };
  const res = await imagePreview({ url: "https://x", session, config: {}, logger: noopLogger,
    deps: { openReader: async () => ({ status: () => 200 }) } });
  assert.equal(res.status, "ok");
  assert.equal(res.images.length, 1);
  assert.equal(closed, true);
});

test("imagePreview fails with NETWORK_ERROR when openReader returns null, and still closes", async () => {
  let closed = false;
  const page = { async evaluate() { throw new Error("must not collect"); }, async close() { closed = true; } };
  const res = await imagePreview({ url: "https://x", session: { async newPage() { return page; } },
    config: {}, logger: noopLogger, deps: { openReader: async () => null } });
  assert.equal(res.status, "fail");
  assert.equal(res.code, "NETWORK_ERROR");
  assert.deepEqual(res.images, []);
  assert.equal(closed, true);
});

test("imagePreview fails with HTTP_ERROR on a >=400 response", async () => {
  const page = { async evaluate() { return []; }, async close() {} };
  const res = await imagePreview({ url: "https://x", session: { async newPage() { return page; } },
    config: {}, logger: noopLogger, deps: { openReader: async () => ({ status: () => 404 }) } });
  assert.equal(res.status, "fail");
  assert.equal(res.code, "HTTP_ERROR");
  assert.deepEqual(res.images, []);
});

test("imagePreview does not throw when the page throws; maps the error and closes", async () => {
  let closed = false;
  const page = { async evaluate() { throw new Error("boom"); }, async close() { closed = true; } };
  const res = await imagePreview({ url: "https://x", session: { async newPage() { return page; } },
    config: {}, logger: noopLogger, deps: { openReader: async () => ({ status: () => 200 }) } });
  assert.equal(res.status, "fail");
  assert.ok(res.code);
  assert.deepEqual(res.images, []);
  assert.equal(closed, true);
});
