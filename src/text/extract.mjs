// src/text/extract.mjs
// Extract an article's main content HTML from an open Playwright page. Prefers a
// profile-provided selector, then @mozilla/readability run INSIDE the page (so no
// jsdom), then article/main/body. Every page call is guarded → null on failure.
import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Read @mozilla/readability's Readability.js source and wrap it so an injected
// <script> exposes the class as window.__Readability (the file ends with
// `module.exports = Readability`, captured by the local `module` here).
let _src = null;
function readabilityScript() {
  if (_src == null) {
    const pkgDir = path.dirname(require.resolve("@mozilla/readability"));
    const code = readFileSync(path.join(pkgDir, "Readability.js"), "utf8");
    _src = `window.__Readability=(function(){const module={exports:{}};${code};return module.exports;})();`;
  }
  return _src;
}

export async function readSelector(page, selector) {
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return { title: document.title || null, html: el.outerHTML || null };
    }, selector);
  } catch { return null; }
}

export async function runReadability(page) {
  try {
    await page.addScriptTag({ content: readabilityScript() });
    return await page.evaluate(() => {
      try {
        const a = new window.__Readability(document.cloneNode(true)).parse();
        return a && a.content ? { title: a.title || null, html: a.content, byline: a.byline || null, excerpt: a.excerpt || null } : null;
      } catch { return null; }
    });
  } catch { return null; }
}

export async function readFallback(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector("article") || document.querySelector("main") || document.body;
      if (!el) return null;
      return { title: document.title || null, html: el.outerHTML || null };
    });
  } catch { return null; }
}

export async function extractArticle(page, { selector } = {}, deps = {}) {
  const rs = deps.readSelector || readSelector;
  const rr = deps.runReadability || runReadability;
  const rf = deps.readFallback || readFallback;
  if (selector) {
    const s = await rs(page, selector);
    if (s && s.html) return { title: s.title || null, html: s.html, byline: null, excerpt: null };
  }
  const a = await rr(page);
  if (a && a.html) return { title: a.title || null, html: a.html, byline: a.byline || null, excerpt: a.excerpt || null };
  const f = await rf(page);
  if (f && f.html) return { title: f.title || null, html: f.html, byline: null, excerpt: null };
  return null;
}
