// Config: layer defaults < config file < CLI args into one validated object.
// The config file (default ./scraper.config.json, or --config <path>) uses the
// same camelCase keys as DEFAULTS below, so recurring settings (drive folder,
// subfolder, format, …) live in one place and CLI flags override them per run.
import { existsSync, readFileSync } from "node:fs";

const FLAGS = new Set(["headed", "all-images", "jpg", "cbz", "cbz-only", "pdf", "pdf-only", "drive", "cleanup", "dry-run", "accept-partial", "no-cache", "clear-cache", "verbose", "debug", "text", "no-http-first"]);
const REPEATABLE = new Set(["select", "pattern"]);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (FLAGS.has(key)) { args[key] = true; continue; }
      if (REPEATABLE.has(key)) { (args[key] ||= []).push(argv[++i]); continue; }
      args[key] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const normalizeDriveOnly = (v) => {
  if (!v) return null;
  const s = String(v).toLowerCase();
  return s === "pdf" || s === "cbz" ? s : null;
};

// The full set of settings and their built-in defaults. Config-file keys are
// matched against these names.
export const DEFAULTS = {
  // sources
  url: null, listFile: null, out: null,
  // navigation / pacing
  advanceKey: "ArrowRight",
  countSelector: "img.reader__item, .reader img, #reader img",
  forcePages: null, settle: 700, jitter: 0.3, maxRetries: 4, rateLimitBase: 2000,
  // Per-site profiles choose the scraping pipeline by URL (see src/profiles/).
  // Set `strategies` to OVERRIDE the profile pipeline globally (array of
  // { name, maxAttempts?, enabled? }); null = use the matched profile.
  strategies: null,
  navTimeout: 45000, itemDelay: 3000, headed: false,
  // rows scraped in parallel (worker-pool size, 1-5); 1 = sequential, unchanged behavior.
  rowConcurrency: 1,
  // circuit breaker: consecutive domain-health failures on one host before it is
  // skipped for the rest of the run (rows stay retryable); grows the delay before
  // then. 0 disables the breaker and the adaptive backoff.
  maxDomainFailures: 3,
  // capture filters
  minBytes: 20000, hostFilter: null, issuePrefix: null, allImages: false,
  // image processing
  format: "keep", quality: 88, maxEdge: 2400,
  // output packagers
  cbz: false, cbzName: null, pdf: false, pdfName: null, keepLoose: true,
  // text content type: scrape the page as HTML→Markdown (.md) instead of images.
  text: false, textName: null,
  // text extraction mode + its inputs; httpFirst = try a static fetch before the browser.
  textMode: "article", textSelect: [], textPatterns: [], httpFirst: true,
  // google drive
  drive: false, driveFolder: null, driveSubfolder: null, driveOnly: null,
  driveCredentials: "credentials.json", driveToken: "token.json",
  // delete a link's local files after it fully succeeds (uploaded), and delete
  // partial files when a download is incomplete, to free disk space.
  cleanup: false,
  // preview the batch (jobs, resolved targets, skip reasons) without launching
  // the browser or contacting Drive.
  dryRun: false,
  // resumable download cache: keep already-downloaded pages on disk between runs
  // so an interrupted job doesn't re-fetch them. `cache` on by default (--no-cache
  // disables); `acceptPartial` keeps a stagnant rerun's pages (--accept-partial).
  cache: true,
  acceptPartial: false,
  // delete each targeted job's resume cache before scraping, forcing a fresh
  // download (still caches this run so a new interruption resumes).
  clearCache: false,
  // observability: raise console verbosity and/or write a full debug trace.
  verbose: false, debug: false, logFile: null,
  // estimate metered-proxy cost: report data volume, and a $ estimate at this
  // per-GB rate when set (e.g. 4 for $4/GB).
  costPerGb: null
};

// Strip // line and /* */ block comments from JSON text without touching
// comment-like sequences inside strings, so the config file can be annotated.
export function stripJsonComments(text) {
  let out = "";
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const c2 = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && c2 === "/") { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") { out += c2 ?? ""; i++; } // keep escaped char verbatim
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && c2 === "/") { inLine = true; i++; continue; }
    if (c === "/" && c2 === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

// Read a JSON settings file (comments allowed). Returns {} if absent (unless
// required). Throws on invalid JSON.
export function loadConfigFile(file, { required = false } = {}) {
  if (!file) return {};
  if (!existsSync(file)) {
    if (required) throw new Error(`Config file not found: ${file}`);
    return {};
  }
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    throw new Error("expected a JSON object");
  } catch (e) {
    throw new Error(`Invalid config file ${file}: ${e.message}`);
  }
}

export function buildConfig(args, fileConfig = {}) {
  const cfg = { ...DEFAULTS };

  // Layer 2: config file (only known keys; null/undefined mean "use default").
  for (const k of Object.keys(DEFAULTS)) {
    if (k in fileConfig && fileConfig[k] !== undefined && fileConfig[k] !== null) cfg[k] = fileConfig[k];
  }

  // Layer 3: CLI args, applied only when actually provided, so they override
  // the file. Boolean flags only ever turn a setting on (never off by absence).
  const has = (k) => k in args;

  if (args._[0]) cfg.url = args._[0];
  if (args.list || args.excel) cfg.listFile = args.list || args.excel;
  if (has("out")) cfg.out = args.out;

  if (has("advance-key")) cfg.advanceKey = args["advance-key"];
  if (has("count-selector")) cfg.countSelector = args["count-selector"];
  if (has("pages")) cfg.forcePages = num(args.pages, cfg.forcePages);
  if (has("settle")) cfg.settle = num(args.settle, cfg.settle);
  if (has("jitter")) cfg.jitter = num(args.jitter, cfg.jitter);
  if (has("max-retries")) cfg.maxRetries = Math.max(0, num(args["max-retries"], cfg.maxRetries));
  if (has("max-domain-failures")) cfg.maxDomainFailures = Math.max(0, num(args["max-domain-failures"], cfg.maxDomainFailures));
  if (has("rate-limit-base")) cfg.rateLimitBase = num(args["rate-limit-base"], cfg.rateLimitBase);
  if (has("nav-timeout")) cfg.navTimeout = num(args["nav-timeout"], cfg.navTimeout);
  if (has("item-delay")) cfg.itemDelay = num(args["item-delay"], cfg.itemDelay);
  if (args.headed) cfg.headed = true;

  if (has("min-bytes")) cfg.minBytes = num(args["min-bytes"], cfg.minBytes);
  if (has("host")) cfg.hostFilter = args.host;
  if (has("issue-prefix")) cfg.issuePrefix = args["issue-prefix"];
  if (args["all-images"]) cfg.allImages = true;

  if (args.jpg) cfg.format = "jpg";
  else if (has("format")) cfg.format = String(args.format).toLowerCase();
  if (has("quality")) cfg.quality = num(args.quality, cfg.quality);
  if (has("max-edge")) cfg.maxEdge = num(args["max-edge"], cfg.maxEdge);

  if (args.cbz || args["cbz-only"]) cfg.cbz = true;
  if (has("cbz-name")) cfg.cbzName = args["cbz-name"];
  if (args.pdf || args["pdf-only"]) cfg.pdf = true;
  if (has("pdf-name")) cfg.pdfName = args["pdf-name"];
  if (args["cbz-only"] || args["pdf-only"]) cfg.keepLoose = false;
  if (args.text) cfg.text = true;
  if (has("text-name")) cfg.textName = args["text-name"];
  if (has("text-mode")) cfg.textMode = String(args["text-mode"]);
  const selects = Array.isArray(args.select) ? args.select : (has("select") ? [args.select] : []);
  const patterns = Array.isArray(args.pattern) ? args.pattern : (has("pattern") ? [args.pattern] : []);
  if (selects.length) { cfg.textSelect = selects; cfg.textMode = "selector"; cfg.text = true; }
  if (patterns.length) { cfg.textPatterns = patterns; cfg.textMode = "pattern"; cfg.text = true; }
  if (args["no-http-first"]) cfg.httpFirst = false;

  if (args.drive) cfg.drive = true;
  if (has("drive-folder")) cfg.driveFolder = args["drive-folder"];
  if (has("drive-subfolder")) cfg.driveSubfolder = args["drive-subfolder"];
  if (has("drive-only")) cfg.driveOnly = args["drive-only"];
  if (has("drive-credentials")) cfg.driveCredentials = args["drive-credentials"];
  if (has("drive-token")) cfg.driveToken = args["drive-token"];
  if (args.cleanup) cfg.cleanup = true;
  if (args["dry-run"]) cfg.dryRun = true;
  if (args["accept-partial"]) cfg.acceptPartial = true;
  if (args["no-cache"]) cfg.cache = false;
  if (args["clear-cache"]) cfg.clearCache = true;
  if (args.verbose) cfg.verbose = true;
  if (args.debug) cfg.debug = true;
  if (has("log-file")) cfg.logFile = args["log-file"];
  if (has("cost-per-gb")) cfg.costPerGb = num(args["cost-per-gb"], cfg.costPerGb);

  // Normalize / derive.
  cfg.format = String(cfg.format).toLowerCase();
  if (cfg.pdf && cfg.format !== "png") cfg.format = "jpg"; // PDF embeds baseline JPEG/PNG
  cfg.quality = clamp(num(cfg.quality, 88), 1, 100);
  cfg.jitter = clamp(num(cfg.jitter, 0.3), 0, 1);
  cfg.driveOnly = normalizeDriveOnly(cfg.driveOnly);
  return cfg;
}

const TEXT_MODES = new Set(["article", "pattern", "selector"]);

export function validateConfig(config) {
  if (!config.url && !config.listFile) return "Provide a reader URL, or --list <file> for batch mode.";
  if (!TEXT_MODES.has(config.textMode)) {
    return `Invalid --text-mode "${config.textMode}" (expected one of: article, pattern, selector).`;
  }
  return null;
}
