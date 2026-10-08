// test/text-markdown.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToMarkdown, buildMarkdownDoc } from "../src/text/markdown.mjs";

test("htmlToMarkdown: converts common HTML to Markdown", () => {
  const md = htmlToMarkdown('<h1>Title</h1><p>Hello <strong>world</strong> and <a href="https://x/">link</a>.</p><ul><li>a</li><li>b</li></ul>');
  assert.match(md, /^# Title/m);
  assert.match(md, /\*\*world\*\*/);
  assert.match(md, /\[link\]\(https:\/\/x\/\)/);
  assert.match(md, /^- a$/m);
  assert.match(md, /^- b$/m);
});

test("htmlToMarkdown: empty/nullish input → empty string", () => {
  assert.equal(htmlToMarkdown(""), "");
  assert.equal(htmlToMarkdown(null), "");
});

test("buildMarkdownDoc: frontmatter has only present fields, H1 title, body", () => {
  const doc = buildMarkdownDoc({ title: 'A "quote"', source: "https://x/1", date: "2026-10-08", byline: "Jane", markdown: "Body here." });
  assert.match(doc, /^---\n/);
  assert.match(doc, /title: "A \\"quote\\""/);
  assert.match(doc, /source: "https:\/\/x\/1"/);
  assert.match(doc, /author: "Jane"/);
  assert.doesNotMatch(doc, /excerpt:/); // omitted when absent
  assert.match(doc, /\n# A "quote"\n/);
  assert.match(doc, /Body here\./);
});

test("buildMarkdownDoc: no fields → no frontmatter, just body", () => {
  const doc = buildMarkdownDoc({ markdown: "Only body." });
  assert.doesNotMatch(doc, /^---/);
  assert.match(doc, /Only body\./);
});

test("buildMarkdownDoc: newline in title/excerpt stays a single-line YAML scalar", () => {
  const doc = buildMarkdownDoc({ title: "Line one\nLine two", excerpt: "a\n\nb", source: "https://x/1", markdown: "Body." });
  // the title frontmatter value is on ONE physical line (no raw newline inside the quotes)
  assert.match(doc, /^title: "Line one Line two"$/m);
  assert.match(doc, /^excerpt: "a b"$/m);
  // frontmatter block is well-formed: opens and closes with ---
  assert.match(doc, /^---\n(?:[^\n]*\n)+---\n/);
});
