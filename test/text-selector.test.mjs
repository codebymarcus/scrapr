// test/text-selector.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";
import { extractSelector } from "../src/text/extractors/selector.mjs";

const html = `<html><body>
<h1 class="title">Hello</h1>
<a class="site" href="https://x/">link</a>
<ul><li class="tag">a</li><li class="tag">b</li></ul>
</body></html>`;

test("extractSelector: textContent (first match) + attr + many", () => {
  const { document } = parseHtml(html);
  const r = extractSelector(document, html, { fields: [
    { name: "title", selector: ".title" },
    { name: "href", selector: ".site", attr: "href" },
    { name: "tags", selector: ".tag", many: true }
  ] });
  assert.equal(r.kind, "selector");
  assert.equal(r.empty, false);
  assert.equal(r.fields.title, "Hello");
  assert.equal(r.fields.href, "https://x/");
  assert.deepEqual(r.fields.tags, ["a", "b"]);
});

test("extractSelector: missing field → null; all missing → empty:true", () => {
  const { document } = parseHtml("<body><p>x</p></body>");
  const r = extractSelector(document, "<body><p>x</p></body>", { fields: [
    { name: "title", selector: ".nope" },
    { name: "tags", selector: ".none", many: true }
  ] });
  assert.equal(r.fields.title, null);
  assert.deepEqual(r.fields.tags, []);
  assert.equal(r.empty, true);
});

test("extractSelector: an invalid CSS selector is treated as no-match (never throws)", () => {
  const { document } = parseHtml("<body><p>x</p></body>");
  const r = extractSelector(document, "<body><p>x</p></body>", { fields: [
    { name: "bad", selector: "::::" },
    { name: "badMany", selector: "[", many: true }
  ] });
  assert.equal(r.fields.bad, null);
  assert.deepEqual(r.fields.badMany, []);
  assert.equal(r.empty, true);
});
