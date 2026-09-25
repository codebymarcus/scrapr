// ImageProcessor: order the captured images by page number, then convert/resize
// each per config into named output buffers ({ name, buffer }). All image
// encoding lives here; packagers just write the buffers.
import sharp from "sharp";

const EXT_BY_TYPE = {
  "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png",
  "image/webp": "webp", "image/gif": "gif", "image/avif": "avif",
  "image/svg+xml": "svg", "image/bmp": "bmp"
};

// Parse a page number from a page-image URL so pages can be ordered, counted,
// and exempted from the small-image (minBytes) filter. Two known formats:
//   A) ".../39131/4-<hash>.jpg"                 → 4   (1-based, dash form)
//   B) ".../213188/<ts>_<idx>_<hash>.jpg"       → idx+1 (batcave: zero-based
//                                                  index between underscores)
export function pageNumberFromUrl(u) {
  const dash = u.match(/\/(\d+)-[a-z0-9]+\.[a-z0-9]+(?:[?#]|$)/i);
  if (dash) return parseInt(dash[1], 10);
  const underscore = u.match(/_(\d{1,4})_[a-z0-9]+\.[a-z0-9]+(?:[?#]|$)/i);
  if (underscore) return parseInt(underscore[1], 10) + 1;
  return null;
}

// Order pages by parsed page number. Images without a parseable number fall
// back to their capture order (`seq`, stamped by ImageCapture) instead of the
// array's network-arrival order, so a site with an unrecognized URL scheme
// still packages deterministically rather than by whichever bytes arrived first.
// Which numbered pages 1..total are absent from the captured images. Empty when
// the total is unknown (nothing to compare against). Used to tell the user
// exactly which page an incomplete download is missing.
export function missingPages(images, total) {
  if (!(total > 0)) return [];
  const present = new Set();
  for (const e of images) {
    const p = pageNumberFromUrl(e.url);
    if (p != null) present.add(p);
  }
  const missing = [];
  for (let n = 1; n <= total; n++) if (!present.has(n)) missing.push(n);
  return missing;
}

// Compress a sorted list of page numbers into a readable "1-3, 7, 9-10" string.
export function formatPageList(nums) {
  if (!nums.length) return "";
  const parts = [];
  let start = nums[0];
  let prev = nums[0];
  const flush = () => parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === prev + 1) { prev = nums[i]; continue; }
    flush();
    start = prev = nums[i];
  }
  flush();
  return parts.join(", ");
}

export function orderImages(images) {
  const bySeq = (a, b) => (a.seq ?? 0) - (b.seq ?? 0);
  const withPage = images.map((e) => ({ ...e, page: pageNumberFromUrl(e.url) }));
  const numbered = withPage.filter((e) => e.page != null).sort((a, b) => a.page - b.page);
  const rest = withPage.filter((e) => e.page == null).sort(bySeq);
  return [...numbered, ...rest];
}

export class ImageProcessor {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  _extFor(e) {
    return EXT_BY_TYPE[e.contentType] || (e.url.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)?.[1] || "img").toLowerCase();
  }

  async _convert(buffer, fmt) {
    const { maxEdge, quality } = this.config;
    const resize = { width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true };
    if (fmt === "jpg" || fmt === "jpeg") {
      // Maximally-compatible baseline JPEG: sRGB (converts CMYK/other), alpha
      // flattened onto white, longest edge capped, non-progressive, no metadata.
      const out = await sharp(buffer)
        .flatten({ background: "#ffffff" })
        .resize(resize)
        .toColourspace("srgb")
        .jpeg({ quality, progressive: false, chromaSubsampling: "4:2:0", mozjpeg: false })
        .toBuffer();
      return { buffer: out, ext: "jpg" };
    }
    if (fmt === "png") {
      const out = await sharp(buffer).resize(resize).toColourspace("srgb").png().toBuffer();
      return { buffer: out, ext: "png" };
    }
    if (fmt === "webp") {
      const out = await sharp(buffer).resize(resize).webp({ quality }).toBuffer();
      return { buffer: out, ext: "webp" };
    }
    return null;
  }

  async process(images) {
    const ordered = orderImages(images);
    const fmt = this.config.format;

    // Warn when most pages lack a parseable page number: those fall back to
    // capture order, which is usually — but not guaranteed to be — page order.
    const unnumbered = ordered.filter((e) => e.page == null).length;
    if (unnumbered > 0 && unnumbered >= ordered.length / 2) {
      this.logger.warn(
        `${unnumbered}/${ordered.length} pages had no page number in their URL; ordering them by capture order — verify the output page order.`
      );
    }

    if (fmt !== "keep") this.logger.info(`converting ${ordered.length} images to ${fmt}…`);

    const width = String(ordered.length).length;
    const outputs = [];
    let n = 0;
    for (const e of ordered) {
      n++;
      const idx = e.page != null ? e.page : n;
      let buffer = e.buffer;
      let ext = this._extFor(e);
      const alreadyWebp = fmt === "webp" && ext === "webp";
      if (fmt !== "keep" && !alreadyWebp) {
        try {
          const c = await this._convert(e.buffer, fmt);
          if (c) { buffer = c.buffer; ext = c.ext; }
        } catch (err) {
          this.logger.warn(`could not convert page ${idx} (${err?.message || err}); keeping original.`);
        }
      }
      outputs.push({ name: `${String(idx).padStart(width, "0")}.${ext}`, buffer });
    }
    return outputs;
  }
}
