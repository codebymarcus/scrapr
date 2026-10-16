import type { ImageRules, Recipe } from "@/lib/schemas";

// The server rejects an empty recipe name, and previews don't need a real one.
export const PREVIEW_NAME = "preview";

/**
 * The saved image recipe. `image.rules` holds the generalizing rule, never
 * the specific test-page images the operator kept or dropped.
 */
export function buildImageRecipe(name: string, rules: ImageRules): Recipe {
  return {
    name,
    contentType: "image",
    image: { rules, pipeline: [] },
    output: { cbz: true },
  };
}

/**
 * The saved text recipe. Article mode is the only mode that needs no
 * selectors, so it is what a detect-only builder can save; the fields the
 * operator kept are recorded in `metadata.textFields`.
 */
export function buildTextRecipe(
  name: string,
  textFields: readonly string[],
): Recipe {
  return {
    name,
    contentType: "text",
    text: { mode: "article" },
    metadata: { textFields: [...textFields] },
  };
}
