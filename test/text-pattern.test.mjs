// test/text-pattern.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";
import { extractPattern, resolvePatterns } from "../src/text/extractors/pattern.mjs";

const html = `<html><body>
<p>Email a@b.com and A@B.COM again, plus c@d.org.</p>
<a href="mailto:hidden@site.io">mail</a>
<p>Call +1-555-123-4567 or visit https://example.com/x</p>
</body></html>`;

test("extractPattern: email preset finds + dedups (case-insensitive), incl. mailto", () => {
  const { document } = parseHtml(html);
  const r = extractPattern(document, html, { patterns: resolvePatterns(["email"]) });
  assert.equal(r.kind, "pattern");
  assert.equal(r.empty, false);
  const emails = r.matches.filter((m) => m.type === "email").map((m) => m.value.toLowerCase());
  assert.ok(emails.includes("a@b.com"));
  assert.ok(emails.includes("c@d.org"));
  assert.ok(emails.includes("hidden@site.io"));
  // a@b.com and A@B.COM dedup to one
  assert.equal(emails.filter((v) => v === "a@b.com").length, 1);
});

test("extractPattern: url + phone presets", () => {
  const { document } = parseHtml(html);
  const r = extractPattern(document, html, { patterns: resolvePatterns(["url", "phone"]) });
  assert.ok(r.matches.some((m) => m.type === "url" && m.value === "https://example.com/x"));
  assert.ok(r.matches.some((m) => m.type === "phone"));
});

test("extractPattern: custom name=/regex/ spec", () => {
  const { document } = parseHtml('<body>SKU-123 and SKU-999</body>');
  const r = extractPattern(document, '<body>SKU-123 and SKU-999</body>', { patterns: resolvePatterns(["sku=/SKU-\\d+/"]) });
  const skus = r.matches.filter((m) => m.type === "sku").map((m) => m.value);
  assert.deepEqual(skus, ["SKU-123", "SKU-999"]);
});

test("extractPattern: no matches → empty:true", () => {
  const { document } = parseHtml("<body>nothing here</body>");
  const r = extractPattern(document, "<body>nothing here</body>", { patterns: resolvePatterns(["email"]) });
  assert.equal(r.empty, true);
  assert.deepEqual(r.matches, []);
});

test("resolvePatterns: rejects an unknown bare word", () => {
  assert.throws(() => resolvePatterns(["bogus"]), /unknown pattern/i);
});
