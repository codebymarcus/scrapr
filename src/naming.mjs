// Naming & output-path resolution: where a job's files, .cbz and .pdf go.
import path from "node:path";

export function slugFromUrl(u) {
  try {
    const { host, pathname } = new URL(u);
    return (host + pathname).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "output";
  } catch {
    return "output";
  }
}

export function sanitizeName(s) {
  return String(s)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .slice(0, 120) || "output";
}

// The resumable-cache dir for a job: a `.scaper-cache/<name>` folder beside the
// output dir (never inside it, so artifact cleanup can't touch the cache).
function cacheDirFor(outDir) {
  return path.join(path.dirname(outDir), ".scaper-cache", path.basename(outDir));
}

// Resolve the output targets for one job.
//   Single-URL mode: --out is the exact output dir.
//   Batch mode:      --out is the PARENT dir; each link gets its own subfolder.
export function resolveTargets(config, job, { outputName } = {}) {
  // Batch mode: a list file (CLI) OR a store-backed run (dashboard). Either way
  // `out` is the PARENT dir and each job gets its own name (job.name > title > slug),
  // so items in one run don't collide on a single run-id-named file.
  if (config.listFile || config.batch) {
    const base = config.out || "downloads";
    // Stable key for the cache dir (never from metadata) so resume is unaffected.
    const cacheKey = job.name ? sanitizeName(job.name) : slugFromUrl(job.url);
    // Display name for the output files: explicit name > metadata title > slug.
    const folder = job.name
      ? sanitizeName(job.name)
      : (outputName ? sanitizeName(outputName) : slugFromUrl(job.url));
    const outDir = path.join(base, folder);
    return {
      outDir,
      cbzPath: path.join(base, `${folder}.cbz`),
      pdfPath: path.join(base, `${folder}.pdf`),
      mdPath: path.join(base, `${folder}.md`),
      cacheDir: cacheDirFor(path.join(base, cacheKey))
    };
  }
  const outDir = config.out || path.join("downloads", slugFromUrl(job.url));
  return {
    outDir,
    cbzPath: config.cbzName || `${outDir}.cbz`,
    pdfPath: config.pdfName || `${outDir}.pdf`,
    mdPath: config.textName || `${outDir}.md`,
    cacheDir: cacheDirFor(outDir)
  };
}

// Run-level base path (no extension) for aggregate record output (.json/.csv).
// Single-URL: --out (or "results"); batch: <out>/results; --text-name overrides.
export function resolveRecordBase(config) {
  if (config.textName) return config.textName;
  if (config.listFile) return path.join(config.out || "downloads", "results");
  return config.out || "results";
}
