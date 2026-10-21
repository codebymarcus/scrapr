// PageCache: a per-job, on-disk cache of downloaded page images, keyed by their
// source URL. It lets an interrupted job resume without re-downloading pages it
// already has: the capture layer seeds from it and writes through to it, and
// the browser is routed to serve cached images from disk instead of the network.
//
// Layout (one dir per job, kept between runs, deleted on success):
//   <dir>/index.json          - { total, issueDir, entries: { url: {...} } }
//   <dir>/<sha1(url)>.<ext>    - the raw image bytes for each page
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const EXT_BY_TYPE = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/bmp": "bmp"
};

const extFor = (contentType, url) =>
  EXT_BY_TYPE[contentType] || url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1]?.toLowerCase() || "img";

export class PageCache {
  constructor(dir, index) {
    this.dir = dir;
    this._index = index || { total: null, issueDir: null, entries: {} };
  }

  // Load an existing cache dir, or start an empty one (created lazily on write).
  static async open(dir) {
    const indexPath = path.join(dir, "index.json");
    if (existsSync(indexPath)) {
      try {
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        index.entries ||= {};
        return new PageCache(dir, index);
      } catch {
        /* corrupt index → start fresh */
      }
    }
    return new PageCache(dir);
  }

  get size() {
    return Object.keys(this._index.entries).length;
  }
  get total() {
    return this._index.total;
  }
  set total(v) {
    this._index.total = v;
  }
  get issueDir() {
    return this._index.issueDir;
  }
  set issueDir(v) {
    this._index.issueDir = v;
  }

  has(url) {
    return Object.prototype.hasOwnProperty.call(this._index.entries, url);
  }

  // Store one page (write-through: the file and the index are both persisted).
  async put(url, buffer, contentType, seq, page) {
    await mkdir(this.dir, { recursive: true });
    const file = `${createHash("sha1").update(url).digest("hex")}.${extFor(contentType, url)}`;
    await writeFile(path.join(this.dir, file), buffer);
    this._index.entries[url] = { file, contentType, seq, page: page ?? null };
    await this.saveIndex();
  }

  async get(url) {
    const meta = this._index.entries[url];
    if (!meta) return null;
    const buffer = await readFile(path.join(this.dir, meta.file)).catch(() => null);
    if (!buffer) return null;
    return { buffer, contentType: meta.contentType, seq: meta.seq, page: meta.page };
  }

  // Every cached page, with its bytes, for seeding a fresh capture.
  async readAll() {
    const out = [];
    for (const url of Object.keys(this._index.entries)) {
      const e = await this.get(url);
      if (e) out.push({ url, ...e });
    }
    return out;
  }

  async saveIndex() {
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, "index.json"), JSON.stringify(this._index, null, 2));
  }

  async clear() {
    await rm(this.dir, { recursive: true, force: true });
    this._index = { total: null, issueDir: null, entries: {} };
  }
}
