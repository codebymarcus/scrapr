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

// A per-run output format maps to the engine's cbz/pdf/keepLoose packaging flags.
// "loose" keeps the images unpackaged; the others package and drop the loose copies.
const FORMAT_FLAGS = {
  cbz: { cbz: true, pdf: false, keepLoose: false },
  pdf: { cbz: false, pdf: true, keepLoose: false },
  both: { cbz: true, pdf: true, keepLoose: false },
  loose: { cbz: false, pdf: false, keepLoose: true },
};

function applyOverrides(config, overrides) {
  for (const key of OVERRIDE_KEYS) {
    if (overrides?.[key] !== undefined) config[key] = overrides[key];
  }
  const flags = overrides?.format && FORMAT_FLAGS[overrides.format];
  if (flags) Object.assign(config, flags);
}

// Mirror the CLI's finalize() packaging normalization (src/config.mjs): PDF
// embeds baseline JPEG/PNG, so images must be converted away from "keep" before
// the pdf packager wraps them, otherwise the PDF comes out empty/broken.
function normalizePackaging(config) {
  config.format = String(config.format).toLowerCase();
  if (config.pdf && config.format !== "png") config.format = "jpg";
}

// Row concurrency is clamped to [1,5]; anything non-numeric falls back to sequential (1).
// The API schema already rejects out-of-range values, but a raw caller could bypass it.
function clampConcurrency(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, Math.round(n)));
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

  // The one per-run override that applies to EVERY run type (text included); set before the
  // branches below so the text early-return still carries it.
  config.rowConcurrency = clampConcurrency(overrides?.concurrency);

  // Built-in recipe: a standard image config. The engine's own URL-matched profile drives
  // extraction, so no imageRules and no text wiring are set.
  if (recipe.builtIn) {
    // A run is a batch of store-backed items: name each output per item
    // (job.name > title > slug) under the run dir, not after the run id.
    config.batch = true;
    copyOutput(config, recipe.output);
    applyOverrides(config, overrides);
    normalizePackaging(config);
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

  // A run is a batch of store-backed items: name each output per item.
  config.batch = true;
  copyOutput(config, recipe.output);
  applyOverrides(config, overrides);
  normalizePackaging(config);
  config.imageRules = imageRulesFromRecipe(recipe);
  return config;
}
