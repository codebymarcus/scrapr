// Job sources: where the list of links comes from. Both implement the same
// interface (`load()` → jobs, `hasStatus`, `setStatus(job, value)`, `setReason(job, text)`) so the
// runner treats a single URL and a spreadsheet identically.
import xlsx from "xlsx";
import { existsSync, writeFileSync } from "node:fs";

// A single URL passed on the command line. No status tracking.
export class UrlSource {
  constructor(url) {
    this.url = url;
    this.hasStatus = false;
  }
  async load() {
    return [{ url: this.url, name: null, status: "", row: -1 }];
  }
  setStatus() {}
  setReason() {}
}

// A .xlsx/.xls/.csv/.tsv of links. Uses a header row with a url/link column
// (optionally name/title), and a `status` column (created if missing) that is
// written back after each row so batches are resumable. Headerless sheets are
// read as "URLs in the first column" with no status tracking.
export class SheetSource {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger;
    this.hasStatus = false;
    this._isText = /\.(csv|tsv|txt)$/i.test(file);
    this._wb = null;
    this._ws = null;
    this._statusCol = -1;
    this._reasonCol = -1;
  }

  async load() {
    const wb = xlsx.readFile(this.file);
    this._wb = wb;
    const ws = wb.Sheets[wb.SheetNames[0]];
    this._ws = ws;
    if (!ws || !ws["!ref"]) return [];

    const range = xlsx.utils.decode_range(ws["!ref"]);
    const hr = range.s.r;
    const cell = (r, c) => ws[xlsx.utils.encode_cell({ r, c })]?.v;

    const header = [];
    for (let c = range.s.c; c <= range.e.c; c++) header[c] = String(cell(hr, c) ?? "").trim().toLowerCase();
    const find = (names) => header.findIndex((h) => names.includes(h));
    const urlCol = find(["url", "link", "links", "href"]);

    // Headerless: first column is links, no status.
    if (urlCol === -1) {
      const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
      const jobs = [];
      for (const r of aoa) {
        const link = String(r[0] ?? "").trim();
        if (/^https?:\/\//i.test(link)) jobs.push({ url: link, name: null, status: "", row: -1 });
      }
      this.hasStatus = false;
      return jobs;
    }

    const nameCol = find(["name", "title", "output", "folder", "cbz"]);
    let statusCol = find(["status"]);
    if (statusCol === -1) {
      statusCol = range.e.c + 1; // append a new status column and grow the range
      ws[xlsx.utils.encode_cell({ r: hr, c: statusCol })] = { t: "s", v: "status" };
      range.e.c = statusCol;
      ws["!ref"] = xlsx.utils.encode_range(range);
    }
    this._statusCol = statusCol;
    this.hasStatus = true;

    // Reuse only an existing explicit `reason` column; otherwise append one. Never adopt
    // `error`/`note`; those are human-maintained and would be overwritten.
    let reasonCol = find(["reason"]);
    if (reasonCol === -1) {
      reasonCol = range.e.c + 1; // append a reason column and grow the range
      ws[xlsx.utils.encode_cell({ r: hr, c: reasonCol })] = { t: "s", v: "reason" };
      range.e.c = reasonCol;
      ws["!ref"] = xlsx.utils.encode_range(range);
    }
    this._reasonCol = reasonCol;

    const jobs = [];
    for (let r = hr + 1; r <= range.e.r; r++) {
      const link = String(cell(r, urlCol) ?? "").trim();
      if (!/^https?:\/\//i.test(link)) continue;
      const name = nameCol >= 0 ? String(cell(r, nameCol) ?? "").trim() : "";
      const status = String(cell(r, statusCol) ?? "").trim().toLowerCase();
      jobs.push({ url: link, name: name || null, status, row: r });
    }
    return jobs;
  }

  _save() {
    try {
      if (this._isText) {
        const FS = /\.tsv$/i.test(this.file) ? "\t" : ",";
        writeFileSync(this.file, xlsx.utils.sheet_to_csv(this._ws, { FS }));
      } else {
        xlsx.writeFile(this._wb, this.file);
      }
    } catch (e) {
      this.logger?.warn(`couldn't write back to ${this.file} (${e.message}). Is it open in Excel?`);
    }
  }

  setStatus(job, value) {
    if (!this.hasStatus || job.row < 0) return;
    this._ws[xlsx.utils.encode_cell({ r: job.row, c: this._statusCol })] = { t: "s", v: value };
    this._save();
  }

  setReason(job, text) {
    if (!this.hasStatus || job.row < 0 || this._reasonCol < 0) return;
    this._ws[xlsx.utils.encode_cell({ r: job.row, c: this._reasonCol })] = { t: "s", v: String(text ?? "") };
    this._save();
  }
}

// Jobs backed by an injected store (e.g. a database) rather than a file. The store supplies
// `loadItems(runId)` → [{ id, url, name, status }] and `setItemStatus(id, value)` /
// `setItemReason(id, text)`. Write failures are logged and swallowed, like SheetSource._save.
//
// Contract: store.setItemStatus / store.setItemReason MUST be SYNCHRONOUS. The try/catch
// below only catches a synchronous throw; it cannot catch a rejection from a returned
// Promise, and `_runJobs` does not await these calls. The real backend store must write
// synchronously (or wrap its async writes internally and handle their own errors).
export class StoreJobSource {
  constructor(store, runId, logger) {
    this.store = store;
    this.runId = runId;
    this.logger = logger;
    this.hasStatus = true;
  }

  async load() {
    const items = await this.store.loadItems(this.runId);
    return items.map((item) => ({ url: item.url, name: item.name, status: item.status, id: item.id }));
  }

  setStatus(job, value) {
    try {
      this.store.setItemStatus(job.id, value);
    } catch (e) {
      this.logger?.warn(`couldn't save status for item ${job.id} (${e.message})`);
    }
  }

  setReason(job, text) {
    try {
      this.store.setItemReason(job.id, text);
    } catch (e) {
      this.logger?.warn(`couldn't save reason for item ${job.id} (${e.message})`);
    }
  }
}

export function createJobSource(config, logger) {
  if (config.listFile) {
    if (!existsSync(config.listFile)) throw new Error(`list file not found: ${config.listFile}`);
    return new SheetSource(config.listFile, logger);
  }
  return new UrlSource(config.url);
}
