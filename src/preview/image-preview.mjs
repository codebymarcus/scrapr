// src/preview/image-preview.mjs
// No-write image preview for a dashboard's project builder. Opens the page in the
// browser, enumerates the candidate <img> elements and returns descriptors for a
// thumbnail grid. It downloads/packages nothing (thumbnail bytes are fetched by
// the backend's proxy) and never throws into the caller.
import { openReader as defaultOpenReader } from "../navigation.mjs";
import { mapError, FailureCode } from "../strategies/strategy.mjs";

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
    const resp = await openReader(page, url, config, logger);
    // openReader never throws on a failed navigation: it returns null (or the
    // final response). Classify so transport failures are reported distinctly.
    if (resp == null) return { status: "fail", code: FailureCode.NETWORK_ERROR, images: [] };
    const status = resp.status?.();
    if (typeof status === "number" && status >= 400) return { status: "fail", code: FailureCode.HTTP_ERROR, images: [] };
    const images = await collectCandidateImages(page, deps);
    return { status: "ok", via: "browser", images };
  } catch (e) {
    logger?.error?.(`image preview failed for ${url}: ${e?.message || e}`);
    return { status: "fail", code: mapError(e), images: [] };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
