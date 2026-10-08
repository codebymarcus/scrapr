// Mechanism factories: name → (params) => strategy. A site profile's pipeline
// (src/profiles/) names these; `params` are per-site overrides merged over config
// at execute time. Adding a mechanism = create its strategy file + one line here.
import { BrowserKeyboardStrategy } from "./browser-keyboard.mjs";
import { ChapterAwareStrategy } from "./chapter-aware.mjs";

export const MECHANISMS = {
  current: (params = {}) => new BrowserKeyboardStrategy({ params }),
  "chapter-aware": (params = {}) => new ChapterAwareStrategy({ params })
};
