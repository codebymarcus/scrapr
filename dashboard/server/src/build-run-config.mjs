import { DEFAULTS } from "../../../src/config.mjs";
import { imageRulesFromRecipe } from "../../../src/recipes/recipe.mjs";
import { DRIVE_CREDENTIALS_PATH, DRIVE_TOKEN_PATH } from "./config.mjs";

// Output keys copied from recipe.output for image recipes; absent keys keep the engine default.
const OUTPUT_KEYS = ["cbz", "pdf", "keepLoose", "quality", "format", "drive", "driveFolder", "driveSubfolder"];

function copyOutput(config, output = {}) {
  for (const key of OUTPUT_KEYS) {
    if (output[key] !== undefined) config[key] = output[key];
  }
}

// Per-run Drive overrides (image output only); unset keys keep what the recipe/engine set.
const OVERRIDE_KEYS = ["drive", "driveFolder", "driveSubfolder"];

function applyOverrides(config, overrides) {
  for (const key of OVERRIDE_KEYS) {
    if (overrides?.[key] !== undefined) config[key] = overrides[key];
  }
}

// Translate a recipe into the engine's flat config. `url`/`listFile` stay null: the
// StoreJobSource supplies the jobs. `out` is the per-run directory the results route reads.
export function buildRunConfig(recipe, { runOutDir, overrides, driveAuth }) {
  const config = {
    ...DEFAULTS,
    out: runOutDir,
    // The engine resolves these against its cwd; make them cwd-independent.
    driveCredentials: DRIVE_CREDENTIALS_PATH,
    driveToken: DRIVE_TOKEN_PATH,
  };
  // In-memory OAuth credentials make the engine skip the credential/token files.
  if (driveAuth) config.driveAuth = driveAuth;

  // Built-in recipe: a standard image config. The engine's own URL-matched profile drives
  // extraction, so no imageRules and no text wiring are set.
  if (recipe.builtIn) {
    copyOutput(config, recipe.output);
    applyOverrides(config, overrides);
    return config;
  }

  if (recipe.contentType === "text") {
    config.text = true;
    config.textMode = recipe.text?.mode ?? DEFAULTS.textMode;
    // Selector fields are NOT copied into textSelect: that CLI-style `name=selector`
    // string form would drop a field's `attr`/`many`. With textSelect empty, scrapeText
    // falls back to the bound profile's text.fields (boundResolver(recipe)), which keeps them.
    if (recipe.text?.patterns?.length) config.textPatterns = [...recipe.text.patterns];
    // Text runs have no output wiring: per-run overrides are deliberately ignored so a text
    // run can never silently turn Drive on.
    return config;
  }

  copyOutput(config, recipe.output);
  applyOverrides(config, overrides);
  config.imageRules = imageRulesFromRecipe(recipe);
  return config;
}
