import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMetadata, buildComicInfoXml } from "../src/metadata.mjs";

// A fake page whose evaluate returns a scripted DOM snapshot.
const pageWith = (dom) => ({ evaluate: async () => dom });

test("extractMetadata: pattern hit pulls title + count from body text", async () => {
  const page = pageWith({ bodyText: "From: Ultimate Hulk Annual\nPage 1 / 29", ogTitle: null, docTitle: "ignored" });
  const md = await extractMetadata(page, { title: /From:\s*(.+)/, count: /Page\s+\d+\s*\/\s*(\d+)/i });
  assert.equal(md.title, "Ultimate Hulk Annual");
  assert.equal(md.count, 29);
});

test("extractMetadata: falls back to og:title then <title> when no title pattern/match", async () => {
  const og = pageWith({ bodyText: "no match", ogTitle: "OG Title", docTitle: "Doc Title" });
  assert.equal((await extractMetadata(og, {})).title, "OG Title");
  const doc = pageWith({ bodyText: "no match", ogTitle: null, docTitle: "Doc Title" });
  assert.equal((await extractMetadata(doc, {})).title, "Doc Title");
});

test("extractMetadata: no title anywhere and non-numeric count → nulls", async () => {
  const page = pageWith({ bodyText: "Page X / many", ogTitle: null, docTitle: "" });
  const md = await extractMetadata(page, { count: /Page\s+\S+\s*\/\s*(\w+)/ });
  assert.equal(md.title, null);
  assert.equal(md.count, null);
});

test("extractMetadata: a throwing evaluate is swallowed → nulls, no throw", async () => {
  const page = { evaluate: async () => { throw new Error("detached"); } };
  assert.deepEqual(await extractMetadata(page, { title: /x/ }), { title: null, count: null });
});

test("buildComicInfoXml: includes present fields, omits empties, escapes XML", () => {
  const xml = buildComicInfoXml({ series: "A & B <C>", title: "A & B <C>", pageCount: 29, web: "https://x/1" });
  assert.match(xml, /<Series>A &amp; B &lt;C&gt;<\/Series>/);
  assert.match(xml, /<PageCount>29<\/PageCount>/);
  assert.match(xml, /<Web>https:\/\/x\/1<\/Web>/);
  assert.doesNotMatch(xml, /undefined/);
});

test("buildComicInfoXml: escapes double and single quotes", () => {
  const xml = buildComicInfoXml({ title: `He said "hi" & it's fine` });
  assert.match(xml, /<Title>He said &quot;hi&quot; &amp; it&apos;s fine<\/Title>/);
  assert.doesNotMatch(xml, /<Title>[^<]*["'][^<]*<\/Title>/);
});

test("buildComicInfoXml: returns null when nothing usable, drops zero/empty", () => {
  assert.equal(buildComicInfoXml({}), null);
  assert.equal(buildComicInfoXml({ title: "", pageCount: 0, web: null }), null);
  assert.doesNotMatch(buildComicInfoXml({ title: "T" }), /<PageCount>/);
});
