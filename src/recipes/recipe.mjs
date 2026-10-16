// Data-driven recipe model. A recipe is a plain JSON-serializable object that a
// dashboard (or any caller) can build without writing code. It is converted into
// the profile shape the engine already consumes (see src/profiles/profile.mjs).
//
// Recipe = {
//   name: string,
//   contentType: "image" | "text",
//   match?: { hosts?: string[] },        // no hosts (or no match) => matches every URL
//   text?: { mode: "article"|"pattern"|"selector", selector?: string,
//            fields?: [{ name, selector, attr?, many? }], patterns?: string[] },
//   image?: {
//     rules?: ImageRules,                // passed through to image filtering
//     pipeline?: Array<{ mechanism: string, maxAttempts?: number, params?: object }>
//   },
//   metadata?: object                    // { title?, count? } regex patterns; defaults to {}
// }
//
// Pure functions only: no I/O, no dependencies beyond the profile helpers.
import { hostMatch } from "../profiles/profile.mjs";

const alwaysMatch = () => true;

// Convert a recipe into a profile. Text recipes get an empty pipeline; image
// recipes use their configured mechanism pipeline.
export function recipeToProfile(recipe) {
  const hosts = recipe.match?.hosts;
  const match = hosts && hosts.length > 0 ? hostMatch(...hosts) : alwaysMatch;
  const pipeline = recipe.contentType === "image" ? (recipe.image?.pipeline ?? []) : [];
  return {
    name: recipe.name,
    match,
    contentType: recipe.contentType,
    ...(recipe.text ? { text: recipe.text } : {}),
    pipeline,
    metadata: recipe.metadata ?? {}
  };
}

// Image filtering rules for a recipe, or null when none are configured.
export function imageRulesFromRecipe(recipe) {
  return recipe.image?.rules ?? null;
}

// Resolver bound to one recipe for a run (§8.1). It ignores the URL and always
// returns this recipe's profile, so it can be injected as `deps.resolveProfile`.
export function boundResolver(recipe) {
  const profile = recipeToProfile(recipe);
  return () => profile;
}
