// test/text-dom.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";

test("parseHtml: returns a queryable Document", () => {
  const { document } = parseHtml('<html><body><h1>Hi</h1><p class="a">x</p><p class="a">y</p></body></html>');
  assert.equal(document.querySelector("h1").textContent, "Hi");
  assert.equal([...document.querySelectorAll("p.a")].map((e) => e.textContent).join(","), "x,y");
});

test("parseHtml: empty/garbage input still yields a Document (no throw)", () => {
  const { document } = parseHtml("");
  assert.ok(document);
  assert.equal(document.querySelector("nope"), null);
});
