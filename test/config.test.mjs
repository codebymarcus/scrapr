// Config layering, JSONC stripping, and normalization.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildConfig, validateConfig, stripJsonComments, DEFAULTS } from "../src/config.mjs";

test("parseArgs: boolean flags vs value options vs positionals", () => {
  const args = parseArgs(["https://x/read", "--jpg", "--out", "downloads", "--quality", "70"]);
  assert.equal(args._[0], "https://x/read");
  assert.equal(args.jpg, true);
  assert.equal(args.out, "downloads");
  assert.equal(args.quality, "70");
});

test("buildConfig: layers defaults < file < CLI", () => {
  const file = { quality: 70, driveFolder: "FILE_ID" };
  const cfg = buildConfig(parseArgs(["url", "--quality", "95"]), file);
  assert.equal(cfg.quality, 95, "CLI overrides file");
  assert.equal(cfg.driveFolder, "FILE_ID", "file value used when no CLI flag");
  assert.equal(cfg.advanceKey, DEFAULTS.advanceKey, "default used when neither set");
});

test("buildConfig: file null/undefined falls back to default", () => {
  const cfg = buildConfig(parseArgs(["url"]), { quality: null, format: undefined });
  assert.equal(cfg.quality, DEFAULTS.quality);
});

test("buildConfig: boolean flags only turn settings on", () => {
  const cfg = buildConfig(parseArgs(["url"]), { drive: true });
  assert.equal(cfg.drive, true, "file can enable");
  const cfg2 = buildConfig(parseArgs(["url", "--drive"]), {});
  assert.equal(cfg2.drive, true, "flag can enable");
});

test("buildConfig: --jpg sets format jpg; pdf forces jpg unless png", () => {
  assert.equal(buildConfig(parseArgs(["url", "--jpg"]), {}).format, "jpg");
  assert.equal(buildConfig(parseArgs(["url", "--pdf"]), {}).format, "jpg");
  assert.equal(buildConfig(parseArgs(["url", "--pdf", "--format", "png"]), {}).format, "png");
});

test("buildConfig: quality clamped 1..100, jitter clamped 0..1", () => {
  assert.equal(buildConfig(parseArgs(["url", "--quality", "999"]), {}).quality, 100);
  assert.equal(buildConfig(parseArgs(["url", "--quality", "0"]), {}).quality, 1);
  assert.equal(buildConfig(parseArgs(["url", "--jitter", "5"]), {}).jitter, 1);
});

test("buildConfig: normalizeDriveOnly keeps pdf/cbz, else null", () => {
  assert.equal(buildConfig(parseArgs(["url", "--drive-only", "cbz"]), {}).driveOnly, "cbz");
  assert.equal(buildConfig(parseArgs(["url", "--drive-only", "PDF"]), {}).driveOnly, "pdf");
  assert.equal(buildConfig(parseArgs(["url", "--drive-only", "junk"]), {}).driveOnly, null);
});

test("buildConfig: --cbz-only enables cbz and drops loose", () => {
  const cfg = buildConfig(parseArgs(["url", "--cbz-only"]), {});
  assert.equal(cfg.cbz, true);
  assert.equal(cfg.keepLoose, false);
});

test("buildConfig: --dry-run is a boolean flag, default false", () => {
  assert.equal(buildConfig(parseArgs(["url"]), {}).dryRun, false);
  assert.equal(buildConfig(parseArgs(["url", "--dry-run"]), {}).dryRun, true);
  assert.equal(buildConfig(parseArgs(["url"]), { dryRun: true }).dryRun, true);
});

test("buildConfig: --accept-partial flag, default false", () => {
  assert.equal(buildConfig(parseArgs(["url"]), {}).acceptPartial, false);
  assert.equal(buildConfig(parseArgs(["url", "--accept-partial"]), {}).acceptPartial, true);
  assert.equal(buildConfig(parseArgs(["url"]), { acceptPartial: true }).acceptPartial, true);
});

test("buildConfig: cache on by default, --no-cache turns it off", () => {
  assert.equal(buildConfig(parseArgs(["url"]), {}).cache, true);
  assert.equal(buildConfig(parseArgs(["url", "--no-cache"]), {}).cache, false);
  assert.equal(buildConfig(parseArgs(["url"]), { cache: false }).cache, false);
});

test("buildConfig: --verbose / --debug flags and --log-file value", () => {
  assert.equal(buildConfig(parseArgs(["url"]), {}).verbose, false);
  assert.equal(buildConfig(parseArgs(["url"]), {}).debug, false);
  assert.equal(buildConfig(parseArgs(["url"]), {}).logFile, null);
  assert.equal(buildConfig(parseArgs(["url", "--verbose"]), {}).verbose, true);
  assert.equal(buildConfig(parseArgs(["url", "--debug"]), {}).debug, true);
  assert.equal(buildConfig(parseArgs(["url", "--log-file", "run.log"]), {}).logFile, "run.log");
});

test("buildConfig: --cost-per-gb value, default null", () => {
  assert.equal(buildConfig(parseArgs(["url"]), {}).costPerGb, null);
  assert.equal(buildConfig(parseArgs(["url", "--cost-per-gb", "4"]), {}).costPerGb, 4);
  assert.equal(buildConfig(parseArgs(["url"]), { costPerGb: 3.5 }).costPerGb, 3.5);
});

test("buildConfig: --clear-cache flag, default false", () => {
  assert.equal(buildConfig(parseArgs(["url"]), {}).clearCache, false);
  assert.equal(buildConfig(parseArgs(["url", "--clear-cache"]), {}).clearCache, true);
  assert.equal(buildConfig(parseArgs(["url"]), { clearCache: true }).clearCache, true);
});

test("validateConfig: requires url or listFile", () => {
  assert.match(validateConfig(buildConfig(parseArgs([]), {})), /Provide a reader URL/);
  assert.equal(validateConfig(buildConfig(parseArgs(["url"]), {})), null);
});

test("stripJsonComments: removes // and /* */ but not inside strings", () => {
  const src = `{
    // line comment
    "a": 1, /* block */ "b": "http://x//y", "c": "/* not a comment */"
  }`;
  const parsed = JSON.parse(stripJsonComments(src));
  assert.deepEqual(parsed, { a: 1, b: "http://x//y", c: "/* not a comment */" });
});

test("strategies: defaults to null (→ default pipeline) when unset", () => {
  const cfg = buildConfig({ _: ["https://x/read"] }, {});
  assert.equal(cfg.strategies, null);
});

test("strategies: a config-file array is carried through verbatim", () => {
  const arr = [{ name: "current", maxAttempts: 2 }, { name: "chapter-aware", enabled: false }];
  const cfg = buildConfig({ _: ["https://x/read"] }, { strategies: arr });
  assert.deepEqual(cfg.strategies, arr);
});

test("maxDomainFailures: defaults to 3", () => {
  const cfg = buildConfig({ _: ["https://x/read"] }, {});
  assert.equal(cfg.maxDomainFailures, 3);
});

test("maxDomainFailures: --max-domain-failures overrides (clamped ≥ 0)", () => {
  assert.equal(buildConfig({ _: ["https://x/read"], "max-domain-failures": "5" }, {}).maxDomainFailures, 5);
  assert.equal(buildConfig({ _: ["https://x/read"], "max-domain-failures": "-2" }, {}).maxDomainFailures, 0);
});

test("maxDomainFailures: config file value is honored", () => {
  const cfg = buildConfig({ _: ["https://x/read"] }, { maxDomainFailures: 0 });
  assert.equal(cfg.maxDomainFailures, 0);
});

test("text: --text sets config.text; default false", () => {
  assert.equal(buildConfig({ _: ["https://x/read"] }, {}).text, false);
  assert.equal(buildConfig({ _: ["https://x/read"], text: true }, {}).text, true);
});

test("text: --text-name sets textName", () => {
  assert.equal(buildConfig({ _: ["https://x/read"], "text-name": "out.md" }, {}).textName, "out.md");
});

test("text modes: --text-mode, repeatable --select/--pattern, --no-http-first", () => {
  const a = parseArgs(["--select", ".a", "--select", "price=.p", "--pattern", "email", "--no-http-first"]);
  assert.deepEqual(a.select, [".a", "price=.p"]);
  assert.deepEqual(a.pattern, ["email"]);
  const c = buildConfig({ _: ["https://x"], select: [".a", "price=.p"] }, {});
  assert.equal(c.textMode, "selector");
  assert.deepEqual(c.textSelect, [".a", "price=.p"]);
  const p = buildConfig({ _: ["https://x"], pattern: ["email"] }, {});
  assert.equal(p.textMode, "pattern");
  assert.equal(buildConfig({ _: ["https://x"], "no-http-first": true }, {}).httpFirst, false);
  assert.equal(buildConfig({ _: ["https://x"] }, {}).httpFirst, true);
});
test("text mode default is article when --text with no select/pattern", () => {
  assert.equal(buildConfig({ _: ["https://x"], text: true }, {}).textMode, "article");
});
