#!/usr/bin/env node
// Headless reader/gallery image scraper — thin CLI entry point.
//
// Drives a headless Chromium the way a person would (past JS gates, pressing the
// "next page" key, letting the site load each image), captures every image, and
// writes them to disk / a .cbz / a .pdf. Handles virtualized readers that keep
// only a few pages in the DOM at a time.
//
// Usage:
//   node scrape.mjs <readerUrl> [options]
//   node scrape.mjs --list links.xlsx [options]     # batch: scrape every link in a sheet
//
// The implementation lives in ./src (see README.md for options & architecture):
//   config, logger, time, naming, browser, navigation, capture, reader,
//   processor, packagers, sources, pipeline.
import { parseArgs, buildConfig, validateConfig, loadConfigFile } from "./src/config.mjs";
import { createLogger } from "./src/logger.mjs";
import { BatchRunner } from "./src/pipeline.mjs";

const USAGE = `Usage:
  node scrape.mjs <readerUrl> [--jpg] [--cbz|--pdf] [--out dir]
  node scrape.mjs --list links.xlsx [--jpg] [--cbz|--pdf] [--out downloads]

Settings can also live in a JSON file (default ./scraper.config.json, or
--config <path>); CLI flags override it. See README.md for the full list.`;

const args = parseArgs(process.argv.slice(2));

// Layer settings: defaults < config file < CLI flags.
const configPath = args.config || "scraper.config.json";
let fileConfig;
try {
  fileConfig = loadConfigFile(configPath, { required: !!args.config });
} catch (e) {
  console.error(`[scaper] ${e.message}`);
  process.exit(1);
}

const config = buildConfig(args, fileConfig);
const problem = validateConfig(config);
if (problem) {
  console.error(`${USAGE}\n\n${problem}`);
  process.exit(1);
}

const logger = createLogger("[scaper]", {
  verbose: config.verbose,
  debug: config.debug,
  logFile: config.logFile
});
if (Object.keys(fileConfig).length) logger.info(`loaded settings from ${configPath}`);
if (config.logFile) logger.info(`writing full debug trace to ${config.logFile}`);
new BatchRunner(config, logger)
  .run()
  .then(async (code) => {
    await logger.close();
    process.exit(code || 0);
  })
  .catch(async (err) => {
    logger.error(err);
    await logger.close();
    process.exit(1);
  });
