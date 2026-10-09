// test/text-article.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../src/text/dom.mjs";
import { extractArticle } from "../src/text/extractors/article.mjs";

const article = `<!doctype html><html><head><title>Doc Title</title>
<meta name="author" content="Jane"></head><body><header>nav</header>
<article><h1>Heading</h1>
<p>First paragraph with <strong>bold</strong>, long enough for the readability scorer to keep this article node in the output of the parse call here.</p>
<p>Second paragraph also sufficiently long so the scorer treats this article element as the page's main content instead of discarding the node.</p>
</article><footer>junk</footer></body></html>`;

test("extractArticle: Readability → markdown with title/byline", () => {
  const { document } = parseHtml(article);
  const r = extractArticle(document, article);
  assert.equal(r.kind, "article");
  assert.equal(r.empty, false);
  assert.match(r.title, /Doc Title|Heading/);
  assert.match(r.markdown, /\*\*bold\*\*/);
});

test("extractArticle: selector override wins", () => {
  const html = '<body><div class="main"><p>Just <em>this</em> block.</p></div><p>other</p></body>';
  const { document } = parseHtml(html);
  const r = extractArticle(document, html, { selector: ".main" });
  assert.match(r.markdown, /_this_|\*this\*/);
});

test("extractArticle: fallback to body when readability yields nothing", () => {
  const html = "<body><p>tiny</p></body>";
  const { document } = parseHtml(html);
  const r = extractArticle(document, html, {}, { runReadability: () => null });
  assert.equal(r.empty, false);
  assert.match(r.markdown, /tiny/);
});

test("extractArticle: truly empty → empty:true", () => {
  const { document } = parseHtml("<body></body>");
  const r = extractArticle(document, "<body></body>", {}, { runReadability: () => null });
  assert.equal(r.empty, true);
});

test("extractArticle: full-document SPA shell with empty body → empty:true (no head/title leak)", () => {
  const html = '<html><head><title>App</title></head><body><div id="root"></div><script>1</script></body></html>';
  const { document } = parseHtml(html);
  const r = extractArticle(document, html, {}, { runReadability: () => null });
  assert.equal(r.empty, true);
  assert.doesNotMatch(r.markdown || "", /App/);
});
