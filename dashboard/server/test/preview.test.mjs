import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { buildApp } from "../src/app.mjs";
import { createBrowserPool } from "../src/browser-pool.mjs";

const recipe = { name: "R", contentType: "image" };
const fakeSession = { id: "session" };
const getBrowser = async () => fakeSession;

function imageResponse(chunks, { type = "image/png", length, status = 200 } = {}) {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      if (pulled >= chunks.length) return controller.close();
      controller.enqueue(chunks[pulled++]);
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers = { "content-type": type };
  if (length !== undefined) headers["content-length"] = String(length);
  const res = new Response(body, { status, headers });
  res.probe = { pulled: () => pulled, cancelled: () => cancelled };
  return res;
}

test("text preview returns the previewText result using the pooled session", async () => {
  const calls = [];
  const previewText = async (args) => {
    calls.push(args);
    return { status: "ok", via: "browser", mode: "selector", fields: [{ name: "title", value: "Hi" }] };
  };
  const app = buildApp({ getBrowser, previewText });
  const res = await app.inject({
    method: "POST",
    url: "/api/preview/text",
    payload: { url: "https://example.com/a", recipe: { ...recipe, contentType: "text" } },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), {
    status: "ok",
    via: "browser",
    mode: "selector",
    fields: [{ name: "title", value: "Hi" }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com/a");
  assert.equal(calls[0].session, fakeSession);
  await app.close();
});

test("preview rejects a non-http(s) url or bad recipe with 400", async () => {
  const app = buildApp({ getBrowser, previewText: async () => ({}), imagePreview: async () => ({}) });
  for (const path of ["/api/preview/text", "/api/preview/image"]) {
    const bad = await app.inject({
      method: "POST",
      url: path,
      payload: { url: "file:///etc/passwd", recipe },
    });
    assert.equal(bad.statusCode, 400);
    const noRecipe = await app.inject({ method: "POST", url: path, payload: { url: "https://x.com" } });
    assert.equal(noRecipe.statusCode, 400);
  }
  await app.close();
});

test("preview returns 502 when the engine throws", async () => {
  const app = buildApp({
    getBrowser,
    imagePreview: async () => {
      throw new Error("boom");
    },
  });
  const res = await app.inject({
    method: "POST",
    url: "/api/preview/image",
    payload: { url: "https://example.com", recipe },
  });
  assert.equal(res.statusCode, 502);
  assert.match(res.json().error, /boom/);
  await app.close();
});

test("image preview includes unenforcedRuleKeys for selector rules", async () => {
  const imagePreview = async ({ url, session }) => {
    assert.equal(session, fakeSession);
    return { status: "ok", via: "browser", images: [{ url: `${url}/i.png`, width: 1, height: 1, selector: "img", index: 0 }] };
  };
  const app = buildApp({ getBrowser, imagePreview });
  const res = await app.inject({
    method: "POST",
    url: "/api/preview/image",
    payload: {
      url: "https://example.com",
      recipe: { ...recipe, image: { rules: { excludeSelector: ".ad", minWidth: 100 } } },
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.images.length, 1);
  assert.deepEqual(body.unenforcedRuleKeys, ["excludeSelector"]);

  const none = await app.inject({
    method: "POST",
    url: "/api/preview/image",
    payload: { url: "https://example.com", recipe },
  });
  assert.deepEqual(none.json().unenforcedRuleKeys, []);
  await app.close();
});

test("thumb streams an image through the server and sets Referer to the origin", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, init };
    return imageResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  };
  const app = buildApp({ fetch });
  const target = "https://cdn.example.com/path/pic.png?x=1";
  const res = await app.inject({ method: "GET", url: `/api/thumb?url=${encodeURIComponent(target)}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "image/png");
  assert.deepEqual([...res.rawPayload], [1, 2, 3, 4, 5]);
  assert.equal(seen.url, target);
  assert.equal(seen.init.headers.Referer ?? seen.init.headers.referer, "https://cdn.example.com/");
  await app.close();
});

test("thumb uses the provided page URL as Referer (defeats hotlink protection)", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, init };
    return imageResponse([new Uint8Array([9])]);
  };
  const app = buildApp({ fetch });
  const target = "https://img.batcave.biz/img/1-abc.jpg";
  const page = "https://batcave.biz/event/world-war-hulk/1";
  const res = await app.inject({
    method: "GET",
    url: `/api/thumb?url=${encodeURIComponent(target)}&referer=${encodeURIComponent(page)}`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.init.headers.Referer ?? seen.init.headers.referer, page);
  await app.close();
});

test("thumb ignores a non-http(s) referer and falls back to the image origin", async () => {
  let seen;
  const fetch = async (url, init) => {
    seen = { url, init };
    return imageResponse([new Uint8Array([1])]);
  };
  const app = buildApp({ fetch });
  const target = "https://cdn.example.com/a.png";
  const res = await app.inject({
    method: "GET",
    url: `/api/thumb?url=${encodeURIComponent(target)}&referer=${encodeURIComponent("javascript:alert(1)")}`,
  });
  assert.equal(res.statusCode, 200);
  assert.equal(seen.init.headers.Referer ?? seen.init.headers.referer, "https://cdn.example.com/");
  await app.close();
});

test("thumb rejects a non-image content-type with 415 and cancels the upstream body", async () => {
  const upstream = imageResponse([new Uint8Array([1])], { type: "text/html" });
  const app = buildApp({ fetch: async () => upstream });
  const res = await app.inject({
    method: "GET",
    url: `/api/thumb?url=${encodeURIComponent("https://example.com/page")}`,
  });
  assert.equal(res.statusCode, 415);
  assert.equal(upstream.probe.cancelled(), true);
  await app.close();
});

test("thumb rejects an over-cap declared content-length with 413", async () => {
  const upstream = imageResponse([new Uint8Array(10)], { length: 5000 });
  const app = buildApp({ fetch: async () => upstream, thumbMaxBytes: 100 });
  const res = await app.inject({
    method: "GET",
    url: `/api/thumb?url=${encodeURIComponent("https://example.com/big.png")}`,
  });
  assert.equal(res.statusCode, 413);
  assert.ok(upstream.probe.pulled() <= 1, "body must not be consumed");
  assert.equal(upstream.probe.cancelled(), true);
  await app.close();
});

test("thumb stops streaming an over-cap body with no content-length", async () => {
  const chunk = new Uint8Array(40);
  const chunks = Array.from({ length: 1000 }, () => chunk);
  const upstream = imageResponse(chunks);
  const app = buildApp({ fetch: async () => upstream, thumbMaxBytes: 100 });
  const res = await app
    .inject({ method: "GET", url: `/api/thumb?url=${encodeURIComponent("https://example.com/big.png")}` })
    .catch(() => null);
  // The body was never read to the end and never delivered beyond the cap.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(upstream.probe.pulled() < 20, `pulled ${upstream.probe.pulled()} chunks`);
  assert.equal(upstream.probe.cancelled(), true);
  if (res) assert.ok(res.rawPayload.length <= 100);
  await app.close();
});

test("thumb rejects non-http(s), missing and malformed urls with 400", async () => {
  let called = false;
  const app = buildApp({
    fetch: async () => {
      called = true;
      return imageResponse([]);
    },
  });
  for (const u of ["file:///etc/passwd", "ftp://example.com/a.png", "javascript:alert(1)", "not a url", ""]) {
    const res = await app.inject({ method: "GET", url: `/api/thumb?url=${encodeURIComponent(u)}` });
    assert.equal(res.statusCode, 400, u);
  }
  assert.equal((await app.inject({ method: "GET", url: "/api/thumb" })).statusCode, 400);
  assert.equal(called, false);
  await app.close();
});

test("thumb maps upstream failures to 502 and never hangs", async () => {
  const failing = buildApp({
    fetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  const a = await failing.inject({
    method: "GET",
    url: `/api/thumb?url=${encodeURIComponent("https://down.example.com/a.png")}`,
  });
  assert.equal(a.statusCode, 502);
  await failing.close();

  const notFound = buildApp({ fetch: async () => imageResponse([], { status: 404 }) });
  const b = await notFound.inject({
    method: "GET",
    url: `/api/thumb?url=${encodeURIComponent("https://example.com/missing.png")}`,
  });
  assert.equal(b.statusCode, 502);
  await notFound.close();

  // A host that never answers: the fetch only settles when the abort signal fires.
  const hanging = buildApp({
    thumbTimeoutMs: 30,
    fetch: (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const c = await hanging.inject({
    method: "GET",
    url: `/api/thumb?url=${encodeURIComponent("https://slow.example.com/a.png")}`,
  });
  assert.equal(c.statusCode, 504);
  await hanging.close();
});

test("browser pool launches lazily once, reuses, and closes", async () => {
  let launches = 0;
  let closes = 0;
  const pool = createBrowserPool({
    launcher: async (config) => {
      launches += 1;
      assert.equal(config.headed, false);
      return { close: async () => { closes += 1; } };
    },
  });
  assert.equal(launches, 0);
  const [a, b] = await Promise.all([pool.getBrowser(), pool.getBrowser()]);
  assert.equal(a, b);
  assert.equal(await pool.getBrowser(), a);
  assert.equal(launches, 1);
  await pool.closeBrowser();
  assert.equal(closes, 1);
  await pool.closeBrowser();
  assert.equal(closes, 1);
  await pool.getBrowser();
  assert.equal(launches, 2);
});

test("browser pool retries after a failed launch", async () => {
  let n = 0;
  const pool = createBrowserPool({
    launcher: async () => {
      n += 1;
      if (n === 1) throw new Error("no chromium");
      return { close: async () => {} };
    },
  });
  await assert.rejects(pool.getBrowser(), /no chromium/);
  assert.ok(await pool.getBrowser());
});

// Real sockets: light-my-request ignores declared lengths, so framing bugs
// (e.g. forwarding upstream Content-Length) only show up over HTTP.
async function withUpstream(handler, run, depsExtra = {}) {
  const upstream = http.createServer(handler);
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const app = buildApp(depsExtra);
  await app.listen({ port: 0, host: "127.0.0.1" });
  const target = `http://127.0.0.1:${upstream.address().port}/img.png`;
  const proxied = `http://127.0.0.1:${app.server.address().port}/api/thumb?url=${encodeURIComponent(target)}`;
  try {
    await run(proxied);
  } finally {
    await app.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test("thumb (real sockets): chunked upstream with no Content-Length is fully proxied", async () => {
  const source = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "image/png" }); // no content-length -> chunked
      res.write(source.subarray(0, 1000));
      setTimeout(() => res.end(source.subarray(1000)), 10);
    },
    async (url) => {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      assert.notEqual(res.headers.get("content-length"), "0");
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(body.length, source.length);
      assert.ok(body.equals(source));
    },
  );
});

test("thumb (real sockets): gzip-encoded upstream comes through fully decoded", async () => {
  const source = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">' + "<g/>".repeat(2000) + "</svg>");
  const gz = gzipSync(source);
  assert.ok(gz.length < source.length);
  await withUpstream(
    (req, res) => {
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        "content-encoding": "gzip",
        "content-length": String(gz.length),
      });
      res.end(gz);
    },
    async (url) => {
      const res = await fetch(url);
      assert.equal(res.status, 200);
      const declared = res.headers.get("content-length");
      assert.notEqual(declared, String(gz.length));
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(source));
    },
  );
});

test("thumb (real sockets): declared oversize upstream gets 413", async () => {
  await withUpstream(
    (req, res) => {
      res.writeHead(200, { "content-type": "image/png", "content-length": "5000" });
      res.end(Buffer.alloc(5000));
    },
    async (url) => {
      assert.equal((await fetch(url)).status, 413);
    },
    { thumbMaxBytes: 100 },
  );
});
