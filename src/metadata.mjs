// Best-effort page metadata extraction and ComicInfo.xml building. Everything
// here is non-fatal: a failure yields nulls / no file, never an exception that
// could fail an otherwise-successful scrape.

// Extract { title, count } from the open reader page. `patterns` is a profile's
// `metadata` object of RegExps applied (in Node) to the page's visible text;
// title falls back to og:title then the document <title>.
export async function extractMetadata(page, patterns = {}) {
  let dom;
  try {
    dom = await page.evaluate(() => ({
      bodyText: document.body?.innerText || "",
      ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute("content") || null,
      docTitle: document.title || null
    }));
  } catch {
    return { title: null, count: null };
  }
  const text = dom?.bodyText || "";
  let title = null;
  if (patterns.title) title = (text.match(patterns.title)?.[1] || "").trim() || null;
  title = title || (dom?.ogTitle || "").trim() || (dom?.docTitle || "").trim() || null;
  let count = null;
  if (patterns.count) {
    const m = text.match(patterns.count);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n)) count = n; }
  }
  return { title, count };
}

// Build a minimal ComicRack ComicInfo.xml. Returns null when no field is usable
// (so no file is written). All values are XML-escaped.
export function buildComicInfoXml({ series, title, pageCount, web } = {}) {
  const fields = [
    ["Series", series],
    ["Title", title],
    ["PageCount", Number.isFinite(pageCount) && pageCount > 0 ? pageCount : null],
    ["Web", web]
  ].filter(([, v]) => v != null && v !== "");
  if (!fields.length) return null;
  const esc = (s) => String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const body = fields.map(([k, v]) => `  <${k}>${esc(v)}</${k}>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n${body}\n</ComicInfo>\n`;
}
