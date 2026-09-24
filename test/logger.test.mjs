// Logger: level gating, verbose/debug, and full-trace file output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLogger, resolveLevel, LEVELS } from "../src/logger.mjs";

function sinkLogger(opts = {}) {
  const out = [];
  const err = [];
  const logger = createLogger("[t]", { out: (s) => out.push(s), err: (s) => err.push(s), ...opts });
  return { logger, out, err, text: () => out.join("\n"), errText: () => err.join("\n") };
}

test("resolveLevel: debug > verbose > normal(info)", () => {
  assert.equal(resolveLevel({}), LEVELS.info);
  assert.equal(resolveLevel({ verbose: true }), LEVELS.verbose);
  assert.equal(resolveLevel({ debug: true }), LEVELS.debug);
  assert.equal(resolveLevel({ verbose: true, debug: true }), LEVELS.debug);
});

test("info level: shows info, hides verbose and debug", () => {
  const { logger, text } = sinkLogger({ level: LEVELS.info });
  logger.info("an-info");
  logger.verbose("a-verbose");
  logger.debug("a-debug");
  assert.match(text(), /an-info/);
  assert.doesNotMatch(text(), /a-verbose/);
  assert.doesNotMatch(text(), /a-debug/);
});

test("verbose level: shows verbose, still hides debug", () => {
  const { logger, text } = sinkLogger({ level: LEVELS.verbose });
  logger.verbose("a-verbose");
  logger.debug("a-debug");
  assert.match(text(), /a-verbose/);
  assert.doesNotMatch(text(), /a-debug/);
});

test("debug level: shows debug", () => {
  const { logger, text } = sinkLogger({ level: LEVELS.debug });
  logger.debug("a-debug");
  assert.match(text(), /a-debug/);
});

test("error goes to the err sink", () => {
  const { logger, errText } = sinkLogger({ level: LEVELS.info });
  logger.error("boom");
  assert.match(errText(), /boom/);
});

test("log file captures every level regardless of console level", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "scaper-log-"));
  const file = path.join(dir, "run.log");
  try {
    const logger = createLogger("[t]", { level: LEVELS.info, out() {}, err() {}, logFile: file });
    logger.info("info-line");
    logger.verbose("verbose-line");
    logger.debug("debug-line");
    await logger.close();
    const contents = await readFile(file, "utf8");
    assert.match(contents, /info-line/);
    assert.match(contents, /verbose-line/, "verbose written to file even at info console level");
    assert.match(contents, /debug-line/, "debug written to file even at info console level");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
