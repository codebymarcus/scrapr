// test/packagers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { CbzPackager, PdfPackager } from "../src/packagers.mjs";
import { PDFDocument } from "pdf-lib";

const noopLogger = { success() {}, warn() {}, step() {}, info() {} };
async function tmp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "scaper-pkg-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
// A real 1x1 JPEG (sharp is already a dependency) so pdf-lib.embedJpg accepts it.
const JPG = await sharp({ create: { width: 1, height: 1, channels: 3, background: "#ffffff" } }).jpeg().toBuffer();

// CbzPackager writes the ZIP STORED (level 0 — images are already compressed), so
// an uncompressed ComicInfo.xml entry appears verbatim in the raw .cbz bytes.
// That lets us assert on the file bytes without adding a zip-reader dependency.

test("CbzPackager: embeds an escaped ComicInfo.xml when metadata is present", async () => {
  await tmp(async (dir) => {
    const dest = path.join(dir, "out.cbz");
    await new CbzPackager(noopLogger).write(
      [{ name: "001.jpg", buffer: JPG }], { cbzPath: dest },
      { series: "Hulk & Co <x>", title: "Hulk", pageCount: 1, web: "https://x/1" }
    );
    const s = (await readFile(dest)).toString("latin1");
    assert.ok(s.includes("ComicInfo.xml"), "entry name present in the archive");
    assert.ok(s.includes("<Series>Hulk &amp; Co &lt;x&gt;</Series>"), "escaped series present");
    assert.ok(s.includes("<PageCount>1</PageCount>"), "page count present");
  });
});

test("CbzPackager: writes NO ComicInfo.xml when metadata is empty", async () => {
  await tmp(async (dir) => {
    const dest = path.join(dir, "out.cbz");
    await new CbzPackager(noopLogger).write([{ name: "001.jpg", buffer: JPG }], { cbzPath: dest }, {});
    const s = (await readFile(dest)).toString("latin1");
    assert.ok(!s.includes("ComicInfo.xml"), "no ComicInfo.xml entry");
  });
});

test("PdfPackager: sets the document title from metadata", async () => {
  await tmp(async (dir) => {
    const dest = path.join(dir, "out.pdf");
    await new PdfPackager(noopLogger).write([{ name: "001.jpg", buffer: JPG }], { pdfPath: dest }, { title: "Hulk Annual" });
    const pdf = await PDFDocument.load(await readFile(dest));
    assert.equal(pdf.getTitle(), "Hulk Annual");
  });
});
