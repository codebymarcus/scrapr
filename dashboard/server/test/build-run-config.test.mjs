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
