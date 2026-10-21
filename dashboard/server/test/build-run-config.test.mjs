import { test } from "node:test";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { buildRunConfig } from "../src/build-run-config.mjs";
import { resolveRecordBase } from "../../../src/naming.mjs";
import { DEFAULTS } from "../../../src/config.mjs";

test("image recipe maps rules and output settings", () => {
  const recipe = {
    name: "Img",
    contentType: "image",
    image: { rules: { minWidth: 400, excludeUrl: "ads" } },
    output: { cbz: true, pdf: true, keepLoose: false, quality: 70, format: "jpg", drive: true, driveFolder: "F", driveSubfolder: "S" },
  };
  const cfg = buildRunConfig(recipe, { runOutDir: "/tmp/run-1" });
  assert.deepEqual(cfg.imageRules, { minWidth: 400, excludeUrl: "ads" });
  assert.equal(cfg.cbz, true);
  assert.equal(cfg.pdf, true);
  assert.equal(cfg.keepLoose, false);
  assert.equal(cfg.quality, 70);
  assert.equal(cfg.format, "jpg");
  assert.equal(cfg.drive, true);
  assert.equal(cfg.driveFolder, "F");
  assert.equal(cfg.driveSubfolder, "S");
  assert.equal(cfg.text, false);
  assert.equal(cfg.url, null);
  assert.equal(cfg.listFile, null);
  assert.equal(cfg.out, "/tmp/run-1");
});

test("image recipe without output falls back to engine defaults", () => {
  const cfg = buildRunConfig({ name: "I", contentType: "image" }, { runOutDir: "/o" });
  for (const k of ["cbz", "pdf", "keepLoose", "quality", "format", "drive", "driveFolder", "driveSubfolder"]) {
    assert.equal(cfg[k], DEFAULTS[k], k);
  }
  assert.equal(cfg.imageRules, null);
});

test("text recipe maps mode and patterns; fields stay on the bound profile", () => {
  const recipe = {
    name: "T",
    contentType: "text",
    text: { mode: "selector", fields: [{ name: "title", selector: "h1", attr: "href", many: true }] },
  };
  const cfg = buildRunConfig(recipe, { runOutDir: "/o" });
  assert.equal(cfg.text, true);
  assert.equal(cfg.textMode, "selector");
  // Left empty so scrapeText falls back to profile.text.fields (keeps attr/many).
  assert.deepEqual(cfg.textSelect, []);
  assert.equal(cfg.url, null);
  assert.equal(cfg.listFile, null);

  const pat = buildRunConfig(
    { name: "P", contentType: "text", text: { mode: "pattern", patterns: ["email", "phone"] } },
    { runOutDir: "/o" },
  );
  assert.equal(pat.textMode, "pattern");
  assert.deepEqual(pat.textPatterns, ["email", "phone"]);
});

test("image recipe: overrides win over output drive settings", () => {
  const recipe = { name: "I", contentType: "image", output: { drive: false, driveFolder: "recipe", driveSubfolder: "rs" } };
  const cfg = buildRunConfig(recipe, {
    runOutDir: "/o",
    overrides: { drive: true, driveFolder: "X", driveSubfolder: "Y" },
  });
  assert.equal(cfg.drive, true);
  assert.equal(cfg.driveFolder, "X");
  assert.equal(cfg.driveSubfolder, "Y");
  // The recipe itself is never mutated.
  assert.equal(recipe.output.drive, false);
  assert.equal(recipe.output.driveFolder, "recipe");
});

test("image recipe: partial/absent overrides leave recipe output untouched", () => {
  const recipe = { name: "I", contentType: "image", output: { drive: true, driveFolder: "F", driveSubfolder: "S" } };
  const partial = buildRunConfig(recipe, { runOutDir: "/o", overrides: { driveFolder: "X" } });
  assert.equal(partial.drive, true);
  assert.equal(partial.driveFolder, "X");
  assert.equal(partial.driveSubfolder, "S");
  const off = buildRunConfig(recipe, { runOutDir: "/o", overrides: { drive: false } });
  assert.equal(off.drive, false);
  const none = buildRunConfig(recipe, { runOutDir: "/o", overrides: null });
  assert.equal(none.drive, true);
  assert.equal(none.driveFolder, "F");
});

test("driveAuth is passed through to config.driveAuth; absent leaves it unset", () => {
  const driveAuth = { clientId: "id", clientSecret: "secret", token: { refresh_token: "r" } };
  const cfg = buildRunConfig({ name: "I", contentType: "image" }, { runOutDir: "/o", driveAuth });
  assert.deepEqual(cfg.driveAuth, driveAuth);
  const without = buildRunConfig({ name: "I", contentType: "image" }, { runOutDir: "/o" });
  assert.equal(without.driveAuth, undefined);
});

test("text recipe ignores drive overrides (never turns Drive on)", () => {
  const recipe = { name: "T", contentType: "text", text: { mode: "pattern", patterns: ["x"] } };
  const cfg = buildRunConfig(recipe, {
    runOutDir: "/o",
    overrides: { drive: true, driveFolder: "X", driveSubfolder: "Y" },
  });
  assert.notEqual(cfg.drive, true);
  assert.equal(cfg.drive, DEFAULTS.drive);
  assert.equal(cfg.driveFolder, DEFAULTS.driveFolder);
  assert.equal(cfg.driveSubfolder, DEFAULTS.driveSubfolder);
  assert.equal(cfg.text, true);
});

test("drive credential/token paths are absolute", () => {
  const cfg = buildRunConfig({ name: "I", contentType: "image" }, { runOutDir: "/o" });
  assert.ok(isAbsolute(cfg.driveCredentials));
  assert.ok(isAbsolute(cfg.driveToken));
});

test("does not mutate DEFAULTS", () => {
  buildRunConfig({ name: "T", contentType: "text", text: { mode: "pattern", patterns: ["x"] } }, { runOutDir: "/o" });
  assert.equal(DEFAULTS.text, false);
  assert.equal(DEFAULTS.out, null);
  assert.deepEqual(DEFAULTS.textPatterns, []);
});

test("contract: record base the engine writes equals the base the results route reads", () => {
  const outDir = "/data/runs/7";
  const runConfig = buildRunConfig({ name: "T", contentType: "text", text: { mode: "article" } }, { runOutDir: outDir });
  // Engine write path: pipeline.mjs -> new RecordWriter(resolveRecordBase(config)) -> `${base}.json`.
  // Route read path (routes/runs.mjs readTextRecords): resolveRecordBase({ out: outDir }).
  assert.equal(runConfig.listFile, null);
  assert.equal(runConfig.textName ?? null, null);
  assert.equal(resolveRecordBase(runConfig), resolveRecordBase({ out: outDir }));
  assert.equal(resolveRecordBase(runConfig), outDir);
});

test("built-in recipe builds an image config with output defaults and no imageRules", () => {
  const recipe = { name: "Batcave", contentType: "image", builtIn: true, builtInProfile: "batcave" };
  const cfg = buildRunConfig(recipe, { runOutDir: "/tmp/run-9" });
  assert.equal(cfg.out, "/tmp/run-9");
  assert.equal(cfg.url, null);
  assert.equal(cfg.listFile, null);
  assert.equal(cfg.text, false);
  assert.equal(cfg.imageRules, undefined);
  for (const k of ["cbz", "pdf", "keepLoose", "quality", "format", "drive", "driveFolder", "driveSubfolder"]) {
    assert.equal(cfg[k], DEFAULTS[k], k);
  }
});

test("built-in recipe honors recipe.output but still sets no imageRules or text wiring", () => {
  const recipe = {
    name: "B",
    contentType: "text",
    builtIn: true,
    image: { rules: { minWidth: 400 } },
    output: { cbz: true, keepLoose: false, quality: 60, format: "jpg", drive: true },
  };
  const cfg = buildRunConfig(recipe, { runOutDir: "/o" });
  assert.equal(cfg.cbz, true);
  assert.equal(cfg.keepLoose, false);
  assert.equal(cfg.quality, 60);
  assert.equal(cfg.format, "jpg");
  assert.equal(cfg.drive, true);
  assert.equal(cfg.text, false);
  assert.equal(cfg.imageRules, undefined);
});

test("format override 'pdf' sets pdf packaging and converts images to jpg", () => {
  const cfg = buildRunConfig(
    { name: "I", contentType: "image", output: { cbz: true } },
    { runOutDir: "/o", overrides: { format: "pdf" } },
  );
  assert.equal(cfg.pdf, true);
  assert.equal(cfg.cbz, false);
  assert.equal(cfg.keepLoose, false);
  assert.equal(cfg.format, "jpg"); // normalized from DEFAULTS "keep" for PDF
});

test("format override 'cbz' packages cbz and leaves format untouched", () => {
  const cfg = buildRunConfig(
    { name: "I", contentType: "image" },
    { runOutDir: "/o", overrides: { format: "cbz" } },
  );
  assert.equal(cfg.cbz, true);
  assert.equal(cfg.pdf, false);
  assert.equal(cfg.keepLoose, false);
  assert.equal(cfg.format, "keep"); // cbz does not force conversion
});

test("format override 'both' packages cbz+pdf and forces jpg", () => {
  const cfg = buildRunConfig(
    { name: "I", contentType: "image" },
    { runOutDir: "/o", overrides: { format: "both" } },
  );
  assert.equal(cfg.cbz, true);
  assert.equal(cfg.pdf, true);
  assert.equal(cfg.format, "jpg");
});

test("format override 'loose' keeps images unpackaged", () => {
  const cfg = buildRunConfig(
    { name: "I", contentType: "image", output: { cbz: true } },
    { runOutDir: "/o", overrides: { format: "loose" } },
  );
  assert.equal(cfg.cbz, false);
  assert.equal(cfg.pdf, false);
  assert.equal(cfg.keepLoose, true);
});

test("pdf with recipe format png is not downgraded to jpg", () => {
  const cfg = buildRunConfig(
    { name: "I", contentType: "image", output: { pdf: true, format: "png" } },
    { runOutDir: "/o" },
  );
  assert.equal(cfg.pdf, true);
  assert.equal(cfg.format, "png");
});

test("built-in recipe honors a format override", () => {
  const cfg = buildRunConfig(
    { name: "B", contentType: "image", builtIn: true, builtInProfile: "x" },
    { runOutDir: "/o", overrides: { format: "pdf" } },
  );
  assert.equal(cfg.pdf, true);
  assert.equal(cfg.format, "jpg");
});

test("image recipes run in batch mode (per-item naming); text recipes do not", () => {
  const img = buildRunConfig({ name: "I", contentType: "image" }, { runOutDir: "/o" });
  assert.equal(img.batch, true);
  const builtIn = buildRunConfig(
    { name: "B", contentType: "image", builtIn: true, builtInProfile: "x" },
    { runOutDir: "/o" },
  );
  assert.equal(builtIn.batch, true);
  const txt = buildRunConfig(
    { name: "T", contentType: "text", text: { mode: "article" } },
    { runOutDir: "/o" },
  );
  assert.notEqual(txt.batch, true);
});

const concImageRecipe = { name: "I", contentType: "image" };
const concTextRecipe = { name: "T", contentType: "text", text: { mode: "selector" } };

test("rowConcurrency comes from overrides.concurrency, clamped to [1,5]", () => {
  const img = buildRunConfig(concImageRecipe, { runOutDir: "/x", overrides: { concurrency: 3 } });
  assert.equal(img.rowConcurrency, 3);
  assert.equal(buildRunConfig(concImageRecipe, { runOutDir: "/x", overrides: { concurrency: 99 } }).rowConcurrency, 5);
  assert.equal(buildRunConfig(concImageRecipe, { runOutDir: "/x", overrides: { concurrency: 0 } }).rowConcurrency, 1);
});

test("rowConcurrency defaults to 1 and applies to text runs too (overrides otherwise ignored)", () => {
  assert.equal(buildRunConfig(concImageRecipe, { runOutDir: "/x", overrides: {} }).rowConcurrency, 1);
  const text = buildRunConfig(concTextRecipe, { runOutDir: "/x", overrides: { concurrency: 4, drive: true } });
  assert.equal(text.rowConcurrency, 4);
  assert.notEqual(text.drive, true); // drive override still ignored for text
});

test("rowConcurrency defensively clamps non-finite, non-number and non-integer values", () => {
  const rc = (concurrency) =>
    buildRunConfig(concImageRecipe, { runOutDir: "/x", overrides: { concurrency } }).rowConcurrency;
  assert.equal(rc(NaN), 1);
  assert.equal(rc(Infinity), 1);
  assert.equal(rc("3"), 1); // strings are not coerced
  assert.equal(rc(2.6), 3); // Math.round
  assert.equal(rc(-4), 1);
});
