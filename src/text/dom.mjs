// src/text/dom.mjs
// Parse an HTML string into a queryable DOM Document using linkedom (pure JS, no
// jsdom). One wrapper used for BOTH the static-fetch body and the browser's
// page.content(), so every extractor sees the same Document type.
import { parseHTML } from "linkedom";

export function parseHtml(html) {
  const { document } = parseHTML(String(html || "<html><body></body></html>"));
  return { document };
}
