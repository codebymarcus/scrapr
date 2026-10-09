// src/text/extractors/pattern.mjs
// Targeted-data extraction by regex (emails, phones, urls, custom). Scans the
// page's visible text AND the raw HTML (to catch mailto:/tel: hrefs and
// attributes), then dedups per type (case-insensitive) preserving first-seen order.
// Pure; never throws.

const PRESETS = {
  email: () => /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  // +country, groups, separators -, ., space, (); 7+ digits overall.
  phone: () => /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){2,4}/g,
  url: () => /https?:\/\/[^\s"'<>)]+/gi
};

// specs: array of "email" | "phone" | "url" | "name=/regex/flags".
// Returns [{ name, regex }] with fresh (global) RegExp objects.
export function resolvePatterns(specs = []) {
  const out = [];
  for (const spec of specs) {
    const s = String(spec);
    if (PRESETS[s]) { out.push({ name: s, regex: PRESETS[s]() }); continue; }
    const eq = s.indexOf("=");
    const name = eq > 0 ? s.slice(0, eq) : "";
    const body = eq > 0 ? s.slice(eq + 1) : "";
    const m = /^\/(.*)\/([a-z]*)$/i.exec(body);
    if (!/^[A-Za-z0-9_-]+$/.test(name) || !m) {
      throw new Error(`unknown pattern "${s}" (use a preset email|phone|url, or name=/regex/flags)`);
    }
    const flags = m[2].includes("g") ? m[2] : m[2] + "g"; // force global for matchAll
    out.push({ name, regex: new RegExp(m[1], flags) });
  }
  return out;
}

export function extractPattern(doc, html, { patterns = [] } = {}) {
  const text = (doc?.body?.textContent || "") + "\n" + String(html || "");
  const matches = [];
  for (const { name, regex } of patterns) {
    const seen = new Set();
    for (const m of text.matchAll(regex)) {
      const value = m[0];
      const key = value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ type: name, value });
    }
  }
  return { kind: "pattern", empty: matches.length === 0, matches };
}
