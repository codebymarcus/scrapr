// src/text/extractors/article.mjs
// Clean-prose extraction: @mozilla/readability run in Node on a linkedom doc
// (the design probe confirmed this works), with a selector/article/main/body
// fallback, converted to Markdown by the existing turndown helper. Pure; never
// throws. Replaces the old in-page (page.evaluate) extractor.
import { Readability } from "@mozilla/readability";
import { htmlToMarkdown } from "../markdown.mjs";

// Readability mutates its document, so parse returns { title, html, byline, excerpt }
// or null. Injectable for tests.
function defaultRunReadability(doc) {
  try {
    const a = new Readability(doc).parse();
    return a && a.content ? { title: a.title || null, html: a.content, byline: a.byline || null, excerpt: a.excerpt || null } : null;
  } catch { return null; }
}

// linkedom quirk: a bare "<body>…</body>" fragment (no <html> wrapper) parses with
// documentElement being the real <body> holding the content and doc.body an empty
// shell. Only in that case use documentElement; for a full document always use
// doc.body (even if empty) so <head>/<title> never leak and an empty/JS-gated page
// stays empty.
function bodyOrFragmentRoot(doc) {
  if (doc.body && cleanInnerHtml(doc.body)) return doc.body;
  const root = doc.documentElement;
  if (root && root.localName === "body") return root;
  return doc.body;
}

// innerHTML of el with non-content nodes (script/style/noscript/template) removed, so
// an SPA shell whose only "content" is a bootstrap <script> stays empty. Never throws.
function cleanInnerHtml(el) {
  try {
    const clone = el.cloneNode(true);
    for (const n of clone.querySelectorAll("script, style, noscript, template")) n.remove();
    return (clone.textContent || "").trim() ? clone.innerHTML : "";
  } catch { return el.innerHTML || ""; }
}

function fallbackHtml(doc, selector) {
  const el =
    (selector && doc.querySelector(selector)) ||
    doc.querySelector("article") ||
    doc.querySelector("main") ||
    bodyOrFragmentRoot(doc);
  return el ? { title: doc.title || null, html: cleanInnerHtml(el), byline: null, excerpt: null } : null;
}

export function extractArticle(doc, html, { selector } = {}, deps = {}) {
  const runReadability = deps.runReadability || defaultRunReadability;
  // Selector override first (profile-provided), else Readability, else body fallback.
  let a = null;
  if (selector) {
    const el = doc.querySelector(selector);
    if (el) a = { title: doc.title || null, html: cleanInnerHtml(el), byline: null, excerpt: null };
  }
  if (!a || !a.html) a = runReadability(doc);
  if (!a || !a.html) a = fallbackHtml(doc, selector);
  const markdown = a && a.html ? htmlToMarkdown(a.html) : "";
  return {
    kind: "article",
    empty: !markdown,
    title: a?.title || null,
    byline: a?.byline || null,
    excerpt: a?.excerpt || null,
    markdown
  };
}
