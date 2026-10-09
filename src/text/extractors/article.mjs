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

function fallbackHtml(doc, selector) {
  const el =
    (selector && doc.querySelector(selector)) ||
    doc.querySelector("article") ||
    doc.querySelector("main") ||
    // linkedom quirk: a bare "<body>…</body>" fragment parses with documentElement
    // being the real content and doc.body an empty shell, so prefer whichever has content.
    (doc.body && (doc.body.textContent || "").trim() ? doc.body : doc.documentElement);
  return el ? { title: doc.title || null, html: el.innerHTML || el.textContent || "", byline: null, excerpt: null } : null;
}

export function extractArticle(doc, html, { selector } = {}, deps = {}) {
  const runReadability = deps.runReadability || defaultRunReadability;
  // Selector override first (profile-provided), else Readability, else body fallback.
  let a = null;
  if (selector) {
    const el = doc.querySelector(selector);
    if (el) a = { title: doc.title || null, html: el.innerHTML || "", byline: null, excerpt: null };
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
