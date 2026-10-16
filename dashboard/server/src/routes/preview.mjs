import { Readable, Transform, pipeline } from "node:stream";
import { imagePreview as defaultImagePreview } from "../../../../src/preview/image-preview.mjs";
import { previewText as defaultPreviewText } from "../../../../src/preview/text-preview.mjs";
import { runtimeUnenforcedImageRuleKeys } from "../../../../src/recipes/image-filter.mjs";
import { createLogger } from "../../../../src/logger.mjs";
import { getBrowser as defaultGetBrowser, previewConfig } from "../browser-pool.mjs";
import { parseOr400, previewSchema } from "../schemas.mjs";

export const THUMB_MAX_BYTES = 10 * 1024 * 1024;
export const THUMB_TIMEOUT_MS = 15_000;

// Only absolute http(s) URLs may be proxied (no file:, ftp:, javascript:, ...).
function parseHttpUrl(raw) {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

// Passes bytes through and errors the moment the running total exceeds `max`,
// so an oversized body is never accumulated in memory.
function capBytes(max) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > max) return cb(new Error("thumbnail exceeds size cap"));
      cb(null, chunk);
    },
  });
}

export async function previewRoutes(app, opts = {}) {
  const getBrowser = opts.getBrowser ?? defaultGetBrowser;
  const previewText = opts.previewText ?? defaultPreviewText;
  const imagePreview = opts.imagePreview ?? defaultImagePreview;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const maxBytes = opts.thumbMaxBytes ?? THUMB_MAX_BYTES;
  const timeoutMs = opts.thumbTimeoutMs ?? THUMB_TIMEOUT_MS;
  const logger = opts.logger ?? createLogger("[preview]", { level: 0 });

  // Runs an engine preview against the pooled browser session. Engine failures
  // that surface as `status: "fail"` are valid results (200); a throw or a
  // browser that cannot start is a gateway-style error.
  async function runPreview(reply, run) {
    let session;
    try {
      session = await getBrowser();
    } catch (err) {
      return reply.code(503).send({ error: `browser unavailable: ${err?.message || err}` });
    }
    try {
      return await run(session);
    } catch (err) {
      return reply.code(502).send({ error: `preview failed: ${err?.message || err}` });
    }
  }

  app.post("/api/preview/text", async (req, reply) => {
    const parsed = parseOr400(previewSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { url, recipe } = parsed.data;
    return runPreview(reply, (session) =>
      previewText({ url, recipe, session, config: previewConfig(), logger, deps: opts.previewDeps }));
  });

  app.post("/api/preview/image", async (req, reply) => {
    const parsed = parseOr400(previewSchema, req.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const { url, recipe } = parsed.data;
    return runPreview(reply, async (session) => {
      const result = await imagePreview({ url, session, config: previewConfig(), logger, deps: opts.previewDeps });
      return { ...result, unenforcedRuleKeys: runtimeUnenforcedImageRuleKeys(recipe.image?.rules) };
    });
  });

  app.get("/api/thumb", async (req, reply) => {
    const target = parseHttpUrl(req.query?.url);
    if (!target) return reply.code(400).send({ error: "url must be an absolute http(s) URL" });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const done = () => clearTimeout(timer);

    let upstream;
    try {
      upstream = await doFetch(target.href, {
        // Referer = the image's own origin defeats simple hotlink protection.
        headers: { Referer: `${target.origin}/`, Accept: "image/*,*/*;q=0.5" },
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (err) {
      done();
      if (controller.signal.aborted) return reply.code(504).send({ error: "upstream timed out" });
      return reply.code(502).send({ error: `upstream unreachable: ${err?.message || err}` });
    }

    const reject = (code, error) => {
      done();
      controller.abort();
      upstream.body?.cancel().catch(() => {});
      return reply.code(code).send({ error });
    };

    if (!upstream.ok) return reject(502, `upstream responded ${upstream.status}`);
    const type = upstream.headers.get("content-type") || "";
    if (!/^image\//i.test(type)) return reject(415, "upstream is not an image");
    // A missing Content-Length (chunked) is null, which must not be read as 0.
    const declared = upstream.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBytes) return reject(413, "image too large");
    if (!upstream.body) return reject(502, "upstream returned no body");

    // Stream (never buffer): the cap transform errors past `maxBytes`;
    // pipeline() then destroys the source (cancelling the upstream body) and
    // the response, and we abort the fetch.
    const source = Readable.fromWeb(upstream.body);
    const stream = pipeline(source, capBytes(maxBytes), (err) => {
      done();
      if (err) controller.abort();
    });
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) stream.destroy();
    });

    reply.header("content-type", type);
    reply.header("cache-control", "private, max-age=300");
    reply.header("x-content-type-options", "nosniff");
    // Never forward upstream Content-Length: fetch decodes gzip/br bodies (so
    // it would be the compressed size) and chunked upstreams have none. The
    // streamed response sets its own framing.
    return reply.send(stream);
  });
}
