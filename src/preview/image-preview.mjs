// src/preview/image-preview.mjs
// No-write image preview for a dashboard's project builder. Opens the page in the
// browser, enumerates the candidate <img> elements and returns descriptors for a
// thumbnail grid. It downloads/packages nothing. Bytes the page itself loaded are
// captured from its own network responses and returned as small downscaled
// data-URI thumbnails (protected sites 403 any out-of-page fetch); candidates
// that were not captured carry no thumbnail and are proxied by the backend.
// Never throws into the caller.
import defaultSharp from "sharp";
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { mapError, FailureCode } from "../strategies/strategy.mjs";

export const CAPTURE_MAX_BYTES = 5_000_000; // raw body cap per captured image
export const THUMB_WIDTH = 320;
export const THUMB_DATA_CAP = 64_000; // max length of the returned data URI

// Attach a response listener that collects image bytes the page loads. Call it
// BEFORE navigating so responses during load are seen. Returns a live Map
// (url -> { buffer, contentType }); `map.settled()` resolves once all in-flight
// body reads have finished.
export function captureImageBytes(page, deps = {}) {
  const maxBytes = deps.captureMaxBytes ?? CAPTURE_MAX_BYTES;
  const map = new Map();
  const pending = new Set();
  Object.defineProperty(map, "settled", {
    enumerable: false,
    value: async () => { await Promise.allSettled([...pending]); },
  });
  if (typeof page?.on !== "function") return map;
  page.on("response", (resp) => {
    const task = (async () => {
      try {
        const url = resp.url();
        if (!url || url.startsWith("data:") || map.has(url)) return;
        const contentType = String(resp.headers?.()["content-type"] || "").split(";")[0].trim().toLowerCase();
        const isImage = resp.request?.().resourceType?.() === "image" || contentType.startsWith("image/");
        if (!isImage || !resp.ok()) return;
        const buffer = await resp.body();
        if (!buffer || buffer.length > maxBytes || map.has(url)) return;
        map.set(url, { buffer, contentType });
      } catch { /* body unavailable (redirect/aborted) — skip */ }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });
  return map;
}

// Downscale to a small data-URI thumbnail; null on failure or if still too big.
export async function toThumbnail(buffer, contentType, deps = {}) {
  const sharp = deps.sharp || defaultSharp;
  try {
    const out = await sharp(buffer).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).toBuffer();
    const type = typeof contentType === "string" && /^image\/[a-z0-9.+-]+$/i.test(contentType) ? contentType : "image/jpeg";
    const uri = `data:${type};base64,${out.toString("base64")}`;
    return uri.length > (deps.thumbDataCap ?? THUMB_DATA_CAP) ? null : uri;
  } catch {
    return null;
  }
}

// Runs in the page: must be self-contained (no Node-scope references).
function collectInPage() {
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      if (n.id) { parts.unshift(`#${CSS.escape(n.id)}`); break; }
      let part = n.tagName.toLowerCase();
      const cls = [...n.classList].slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
      part += cls;
      const sibs = n.parentElement ? [...n.parentElement.children].filter((s) => s.tagName === n.tagName) : [];
      if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(n) + 1})`;
      parts.unshift(part);
    }
    return parts.join(" > ");
  };
  return [...document.images].map((img, index) => ({
    url: img.currentSrc || img.src || "",
    width: img.naturalWidth || 0,
    height: img.naturalHeight || 0,
    selector: pathOf(img),
    index,
  })).filter((d) => d.url);
}

export async function collectCandidateImages(page, deps = {}) {
  const evaluate = deps.collectInPage || collectInPage;
  const out = await page.evaluate(evaluate);
  return Array.isArray(out) ? out : [];
}

export async function imagePreview({ url, session, config, logger, deps = {} }) {
  const openReader = deps.openReader || defaultOpenReader;
  let page;
  try {
    page = await session.newPage();
    const captured = captureImageBytes(page, deps);
    const resp = await openReader(page, url, config, logger);
    // openReader never throws on a failed navigation: it returns null (or the
    // final response). Classify so transport failures are reported distinctly.
    if (resp == null) return { status: "fail", code: FailureCode.NETWORK_ERROR, images: [] };
    const status = resp.status?.();
    if (typeof status === "number" && status >= 400) return { status: "fail", code: FailureCode.HTTP_ERROR, images: [] };
    const images = await collectCandidateImages(page, deps);
    await captured.settled();
    const have = new Set(images.map((i) => i.url));
    for (const capturedUrl of captured.keys()) {
      if (!have.has(capturedUrl)) {
        images.push({ url: capturedUrl, width: 0, height: 0, selector: "", index: images.length });
      }
    }
    for (const img of images) {
      const hit = captured.get(img.url);
      if (!hit) continue;
      const thumbnail = await toThumbnail(hit.buffer, hit.contentType, deps);
      if (thumbnail) img.thumbnail = thumbnail;
    }
    return { status: "ok", via: "browser", images };
  } catch (e) {
    logger?.error?.(`image preview failed for ${url}: ${e?.message || e}`);
    return { status: "fail", code: mapError(e), images: [] };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
