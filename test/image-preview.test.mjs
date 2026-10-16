import { test } from "node:test";
import assert from "node:assert/strict";
import { collectCandidateImages, imagePreview, captureImageBytes, toThumbnail, THUMB_DATA_CAP, CAPTURE_MAX_BYTES } from "../src/preview/image-preview.mjs";

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

// ---- byte capture + thumbnails ----

function fakeResp({ url, type = "image", ct = "image/png", ok = true, body = Buffer.from("x") }) {
  return {
    url: () => url,
    ok: () => ok,
    headers: () => ({ "content-type": ct }),
    request: () => ({ resourceType: () => type }),
    body: async () => body,
  };
}

function fakeEventPage() {
  const handlers = [];
  return {
    on(evt, fn) { if (evt === "response") handlers.push(fn); },
    emit(resp) { for (const h of handlers) h(resp); },
  };
}

test("captureImageBytes keeps only small, ok, non-data image responses, deduped", async () => {
  const page = fakeEventPage();
  const map = captureImageBytes(page);
  page.emit(fakeResp({ url: "https://x/a.png", body: Buffer.from("AAA") }));
  page.emit(fakeResp({ url: "https://x/a.png", body: Buffer.from("BBBB") })); // dup
  page.emit(fakeResp({ url: "https://x/page.html", type: "document", ct: "text/html" }));
  page.emit(fakeResp({ url: "data:image/png;base64,AAAA" }));
  page.emit(fakeResp({ url: "https://x/big.png", body: Buffer.alloc(CAPTURE_MAX_BYTES + 1) }));
  page.emit(fakeResp({ url: "https://x/403.png", ok: false }));
  page.emit(fakeResp({ url: "https://x/ct.bin", type: "fetch", ct: "image/webp; charset=x", body: Buffer.from("W") }));
  await map.settled();
  assert.deepEqual([...map.keys()].sort(), ["https://x/a.png", "https://x/ct.bin"]);
  assert.equal(map.get("https://x/a.png").buffer.toString(), "AAA");
  assert.equal(map.get("https://x/a.png").contentType, "image/png");
});

test("captureImageBytes tolerates a page without .on and body() failures", async () => {
  assert.equal(captureImageBytes({}).size, 0);
  const page = fakeEventPage();
  const map = captureImageBytes(page);
  const bad = fakeResp({ url: "https://x/b.png" });
  bad.body = async () => { throw new Error("gone"); };
  page.emit(bad);
  await map.settled();
  assert.equal(map.size, 0);
});

test("toThumbnail returns a data URI using an injected sharp", async () => {
  const sharp = () => ({ resize: () => ({ toBuffer: async () => Buffer.from("tiny") }) });
  const uri = await toThumbnail(Buffer.from("raw"), "image/png", { sharp });
  assert.equal(uri, `data:image/png;base64,${Buffer.from("tiny").toString("base64")}`);
  const fallback = await toThumbnail(Buffer.from("raw"), "application/octet-stream", { sharp });
  assert.ok(fallback.startsWith("data:image/jpeg;base64,"));
});

test("toThumbnail returns null when sharp throws", async () => {
  const sharp = () => ({ resize: () => ({ toBuffer: async () => { throw new Error("bad image"); } }) });
  assert.equal(await toThumbnail(Buffer.from("raw"), "image/png", { sharp }), null);
});

test("toThumbnail returns null when the data URI exceeds THUMB_DATA_CAP", async () => {
  const sharp = () => ({ resize: () => ({ toBuffer: async () => Buffer.alloc(THUMB_DATA_CAP) }) });
  assert.equal(await toThumbnail(Buffer.from("raw"), "image/png", { sharp }), null);
});

test("imagePreview attaches thumbnails to captured candidates and merges captured-only URLs", async () => {
  const page = fakeEventPage();
  page.evaluate = async () => [
    { url: "https://x/cap.png", width: 10, height: 10, selector: "img.a", index: 0 },
    { url: "https://x/nocap.png", width: 10, height: 10, selector: "img.b", index: 1 },
  ];
  page.close = async () => {};
  const sharp = () => ({ resize: () => ({ toBuffer: async () => Buffer.from("T") }) });
  const openReader = async (p) => {
    p.emit(fakeResp({ url: "https://x/cap.png", body: Buffer.from("1") }));
    p.emit(fakeResp({ url: "https://x/only-net.png", body: Buffer.from("2") }));
    return { status: () => 200 };
  };
  const res = await imagePreview({ url: "https://x", session: { async newPage() { return page; } },
    config: {}, logger: noopLogger, deps: { openReader, sharp } });
  assert.equal(res.status, "ok");
  assert.equal(res.images.length, 3);
  const by = Object.fromEntries(res.images.map((i) => [i.url, i]));
  assert.ok(by["https://x/cap.png"].thumbnail.startsWith("data:image/png;base64,"));
  assert.equal("thumbnail" in by["https://x/nocap.png"], false);
  assert.ok(by["https://x/only-net.png"].thumbnail);
  assert.equal(by["https://x/only-net.png"].width, 0);
  assert.equal(by["https://x/only-net.png"].selector, "");
  assert.equal(by["https://x/only-net.png"].index, 2);
});

test("imagePreview omits thumbnail when toThumbnail yields null", async () => {
  const page = fakeEventPage();
  page.evaluate = async () => [{ url: "https://x/cap.png", width: 1, height: 1, selector: "img", index: 0 }];
  page.close = async () => {};
  const sharp = () => ({ resize: () => ({ toBuffer: async () => { throw new Error("nope"); } }) });
  const openReader = async (p) => { p.emit(fakeResp({ url: "https://x/cap.png" })); return { status: () => 200 }; };
  const res = await imagePreview({ url: "https://x", session: { async newPage() { return page; } },
    config: {}, logger: noopLogger, deps: { openReader, sharp } });
  assert.equal("thumbnail" in res.images[0], false);
});
