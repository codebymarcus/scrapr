// src/text/records.mjs
// Aggregate record output for pattern/selector modes: one row per URL, written
// incrementally to <base>.json (arrays preserved) and <base>.csv (array cells
// joined with "; "). Rewrites both files after every append so a mid-run crash
// keeps completed URLs. CSV via the already-present xlsx dep.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import xlsx from "xlsx";

export class RecordWriter {
  constructor(base, deps = {}) {
    this.jsonPath = `${base}.json`;
    this.csvPath = `${base}.csv`;
    this._records = [];
    this._writeFile = deps.writeFile || writeFile;
    this._ensured = false;
  }

  get count() { return this._records.length; }

  async append(record) {
    this._records.push(record);
    await this._flush();
  }

  async _flush() {
    if (!this._ensured) { await mkdir(path.dirname(this.jsonPath), { recursive: true }); this._ensured = true; }
    await this._writeFile(this.jsonPath, JSON.stringify(this._records, null, 2));
    // Union of keys, url first, first-seen order after.
    const header = ["url"];
    for (const r of this._records) for (const k of Object.keys(r)) if (!header.includes(k)) header.push(k);
    const rows = this._records.map((r) => {
      const row = {};
      for (const k of header) {
        const v = r[k];
        row[k] = Array.isArray(v) ? v.join("; ") : (v == null ? "" : v);
      }
      return row;
    });
    const ws = xlsx.utils.json_to_sheet(rows, { header });
    await this._writeFile(this.csvPath, xlsx.utils.sheet_to_csv(ws));
  }
}
