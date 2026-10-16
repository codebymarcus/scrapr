import { DEFAULTS } from "../../../src/config.mjs";
import { imageRulesFromRecipe } from "../../../src/recipes/recipe.mjs";
import { DRIVE_CREDENTIALS_PATH, DRIVE_TOKEN_PATH } from "./config.mjs";

// Output keys copied from recipe.output for image recipes; absent keys keep the engine default.
const OUTPUT_KEYS = ["cbz", "pdf", "keepLoose", "quality", "format", "drive", "driveFolder", "driveSubfolder"];

// Translate a recipe into the engine's flat config. `url`/`listFile` stay null: the
// StoreJobSource supplies the jobs. `out` is the per-run directory the results route reads.
export function buildRunConfig(recipe, { runOutDir }) {
  const config = {
    ...DEFAULTS,
    out: runOutDir,
    // The engine resolves these against its cwd; make them cwd-independent.
    driveCredentials: DRIVE_CREDENTIALS_PATH,
    driveToken: DRIVE_TOKEN_PATH,
  };

  if (recipe.contentType === "text") {
    config.text = true;
    config.textMode = recipe.text?.mode ?? DEFAULTS.textMode;
    // Selector fields are NOT copied into textSelect: that CLI-style `name=selector`
    // string form would drop a field's `attr`/`many`. With textSelect empty, scrapeText
    // falls back to the bound profile's text.fields (boundResolver(recipe)), which keeps them.
    if (recipe.text?.patterns?.length) config.textPatterns = [...recipe.text.patterns];
    return config;
  }

  const output = recipe.output ?? {};
  for (const key of OUTPUT_KEYS) {
    if (output[key] !== undefined) config[key] = output[key];
  }
  config.imageRules = imageRulesFromRecipe(recipe);
  return config;
}
