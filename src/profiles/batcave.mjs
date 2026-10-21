// batcave.biz "event" reader: a continuous/looping multi-chapter reader whose
// pages are addressed by #page-N fragment. Uses only the chapter-aware
// (hash-addressing) mechanism; keyboard-advance always fails here.
import { hostMatch, ContentType } from "./profile.mjs";

export default {
  name: "batcave",
  match: hostMatch("batcave.biz"),
  contentType: ContentType.IMAGE,
  pipeline: [{ mechanism: "chapter-aware", maxAttempts: 1, params: {} }],
  // Metadata patterns used by extractMetadata (title + page count; auto-naming/ComicInfo).
  metadata: { title: /From:\s*(.+)/, count: /Page\s+\d+\s*\/\s*(\d+)/i }
};
