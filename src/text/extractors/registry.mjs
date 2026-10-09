// src/text/extractors/registry.mjs
// name → extractor(doc, html, opts). Mirrors strategies/registry.mjs. Adding a
// mode = create its file + one line here.
import { extractPattern } from "./pattern.mjs";
import { extractSelector } from "./selector.mjs";

export const EXTRACTORS = {
  pattern: extractPattern,
  selector: extractSelector
};
