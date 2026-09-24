// Logger: the single place console output is formatted. Adds ANSI colours (only
// on a TTY, honouring NO_COLOR) to distinguish statuses, plus a transient
// progress bar. Injected everywhere so output stays consistent and testable.
//
// Levels (low → high): error < warn < info < verbose < debug. The console shows
// messages at or below the active level; a --log-file, when set, records EVERY
// message (all levels, uncoloured, timestamped) so a full trace survives even a
// quiet console.
import { createWriteStream } from "node:fs";

export const LEVELS = { error: 0, warn: 1, info: 2, verbose: 3, debug: 4 };
const NAME = ["ERROR", "WARN", "INFO", "VERBOSE", "DEBUG"];

const COLOR =
  !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";

const paint = (code, s) => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);

// Pick the console level from the flags (debug wins, then verbose, then info).
export function resolveLevel({ verbose = false, debug = false } = {}) {
  if (debug) return LEVELS.debug;
  if (verbose) return LEVELS.verbose;
  return LEVELS.info;
}

export function createLogger(prefix = "[scaper]", opts = {}) {
  const level = opts.level ?? resolveLevel(opts);
  const out = opts.out || ((s) => console.log(s));
  const errOut = opts.err || ((s) => console.error(s));
  const fileStream = opts.logFile ? createWriteStream(opts.logFile, { flags: "w" }) : null;

  const P = paint("90", prefix); // dim prefix
  let progressActive = false;

  const clearProgress = () => {
    if (progressActive && COLOR) process.stdout.write("\r\x1b[K");
    progressActive = false;
  };

  const toText = (m) => (typeof m === "string" ? m : m?.message || String(m));

  // Core sink: always record to the file (all levels); print to the console only
  // when the message's level is at or below the active console level.
  const emit = (msgLevel, m, { code = null, isErr = false, newline = false } = {}) => {
    const text = toText(m);
    if (fileStream) fileStream.write(`${new Date().toISOString()} ${NAME[msgLevel].padEnd(7)} ${text}\n`);
    if (msgLevel > level) return;
    clearProgress();
    const line = `${newline ? "\n" : ""}${P} ${code ? paint(code, text) : text}`;
    (isErr ? errOut : out)(line);
  };

  return {
    LEVELS,
    level,
    info: (m) => emit(LEVELS.info, m),
    success: (m) => emit(LEVELS.info, m, { code: "32" }), // green
    warn: (m) => emit(LEVELS.warn, m, { code: "33" }), // yellow
    muted: (m) => emit(LEVELS.info, m, { code: "90" }), // gray
    step: (m) => emit(LEVELS.info, m, { code: "36" }), // cyan
    section: (m) => emit(LEVELS.info, m, { code: "1;36", newline: true }), // bold cyan
    error: (m) => emit(LEVELS.error, m, { code: "31", isErr: true }),
    verbose: (m) => emit(LEVELS.verbose, m, { code: "90" }),
    debug: (m) => emit(LEVELS.debug, m, { code: "90" }),

    // Transient progress bar (TTY only; no-op when piped — a final line covers
    // it). `human: true` formats the counts as MB (for byte-based progress).
    progressBar: (current, total, label = "", { human = false } = {}) => {
      if (!COLOR) return;
      const width = 24;
      const fmt = human ? (n) => `${(n / 1048576).toFixed(1)}MB` : (n) => String(n);
      if (total > 0) {
        const ratio = Math.min(1, current / total);
        const filled = Math.round(ratio * width);
        const bar = paint("32", "█".repeat(filled)) + paint("90", "░".repeat(width - filled));
        process.stdout.write(`\r${P} [${bar}] ${fmt(current)}/${fmt(total)} ${Math.round(ratio * 100)}% ${label}\x1b[K`);
      } else {
        process.stdout.write(`\r${P} ${fmt(current)} ${label}…\x1b[K`);
      }
      progressActive = true;
    },
    endProgress: () => { if (progressActive) { process.stdout.write("\n"); progressActive = false; } },

    // Flush and close the log file (if any). Call once at the end of a run.
    close: () =>
      new Promise((resolve) => {
        if (!fileStream) return resolve();
        fileStream.end(resolve);
      })
  };
}
