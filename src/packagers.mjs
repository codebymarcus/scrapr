// Packagers: each turns the processed page buffers into an output form. They
// share one interface, `write(outputs, targets)`, so new formats can be added
// without touching the scraper (Open/Closed). `buildPackagers` selects which to
// run from config.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import archiver from "archiver";
import { PDFDocument } from "pdf-lib";
import { buildComicInfoXml } from "./metadata.mjs";

const mb = (bytes) => (bytes / 1048576).toFixed(1);

// Loose image files on disk.
export class LoosePackager {
  constructor(logger) { this.logger = logger; }
  async write(outputs, targets, _metadata) {
    if (!existsSync(targets.outDir)) await mkdir(targets.outDir, { recursive: true });
    for (const o of outputs) await writeFile(path.join(targets.outDir, o.name), o.buffer);
    this.logger.success(`saved ${outputs.length} images → ${path.resolve(targets.outDir)}`);
  }
}

// A .cbz (ZIP of images, stored; images are already compressed).
export class CbzPackager {
  constructor(logger) { this.logger = logger; }
  async write(outputs, targets, metadata) {
    let dest = targets.cbzPath;
    if (!dest.toLowerCase().endsWith(".cbz")) dest += ".cbz";
    await mkdir(path.dirname(dest), { recursive: true });
    const comicInfo = buildComicInfoXml(metadata || {});
    const bytes = await new Promise((resolve, reject) => {
      const out = createWriteStream(dest);
      const archive = archiver("zip", { zlib: { level: 0 } });
      out.on("close", () => resolve(archive.pointer()));
      out.on("error", reject);
      archive.on("error", reject);
      archive.pipe(out);
      for (const f of outputs) archive.append(f.buffer, { name: f.name });
      if (comicInfo) archive.append(Buffer.from(comicInfo, "utf8"), { name: "ComicInfo.xml" });
      archive.finalize();
    });
    this.logger.success(`wrote ${outputs.length}-page CBZ (${mb(bytes)} MB)${comicInfo ? " + ComicInfo.xml" : ""} → ${dest}`);
  }
}

// A .pdf, one page per image (page sized to the image), no encryption. Only
// baseline JPEG/PNG can be embedded; the processor produces those.
export class PdfPackager {
  constructor(logger) { this.logger = logger; }
  async write(outputs, targets, metadata) {
    let dest = targets.pdfPath;
    if (!dest.toLowerCase().endsWith(".pdf")) dest += ".pdf";
    await mkdir(path.dirname(dest), { recursive: true });
    const pdf = await PDFDocument.create();
    if (metadata?.title) pdf.setTitle(String(metadata.title));
    for (const f of outputs) {
      const isPng = /\.png$/i.test(f.name);
      const img = isPng ? await pdf.embedPng(f.buffer) : await pdf.embedJpg(f.buffer);
      const page = pdf.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    }
    const bytes = await pdf.save();
    await writeFile(dest, bytes);
    this.logger.success(`wrote ${outputs.length}-page PDF (${mb(bytes.length)} MB) → ${dest}`);
  }
}

export function buildPackagers(config, logger) {
  const packagers = [];
  if (config.keepLoose) packagers.push(new LoosePackager(logger));
  if (config.cbz) packagers.push(new CbzPackager(logger));
  if (config.pdf) packagers.push(new PdfPackager(logger));
  return packagers;
}
