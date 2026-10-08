// Generic default profile (catch-all): today's behaviour for any site without a
// dedicated profile — a single keyboard-advance pass.
import { ContentType } from "./profile.mjs";

export default {
  name: "generic",
  match: () => true,
  contentType: ContentType.IMAGE,
  pipeline: [{ mechanism: "current", maxAttempts: 2, params: {} }],
  metadata: {}
};
