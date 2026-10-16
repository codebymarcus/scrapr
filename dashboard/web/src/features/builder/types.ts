import type { ImagePreview, ImageRules, Recipe } from "@/lib/schemas";

/** What "Fetch & detect" looks for. Links and tables have no preview yet. */
export type DetectScope = "images" | "text" | "links" | "tables";

export type ImageCandidate = NonNullable<ImagePreview["images"]>[number];

/** Body of `POST /api/preview/image` and `/api/preview/text`. */
export type PreviewInput = {
  url: string;
  recipe: Recipe;
};

/**
 * The rule form's editable state. Numbers are kept as strings so a half-typed
 * value survives; `draftToRules` turns it into the saved `ImageRules`.
 */
export type RuleDraft = {
  minWidth: string;
  minHeight: string;
  includeUrl: string;
  excludeUrl: string;
};

/** One detected text field, normalized from the preview's loose `fields`. */
export type TextFieldEntry = {
  name: string;
  value: string;
};

export type { ImageRules };
