// BandwidthMeter: totals the bytes a page actually transfers over the network,
// so a run's data volume (and, with a rate, its proxy cost) can be surfaced.
// Metered-proxy providers (Bright Data, Oxylabs, …) bill on ALL bytes through
// the proxy (HTML, JS, CSS, every image kept or filtered, trackers), not just
// the pages we save, so this counts every finished request via request.sizes().
// Pages served from the local resume cache never touch the proxy, so a `skip`
// predicate excludes them.

// Human-readable size in DECIMAL units (KB=1e3, MB=1e6, GB=1e9), matching how
// proxy providers meter and bill, so the volume and the cost estimate agree.
export function formatBytes(bytes) {
  if (bytes < 1e3) return `${bytes} B`;
  if (bytes < 1e6) return `${(bytes / 1e3).toFixed(1)} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

// Estimated cost at a per-GB rate (GB = 1e9 bytes, the billing convention).
export function estimateCost(bytes, costPerGb) {
  return (bytes / 1e9) * costPerGb;
}

// One-line "volume across N requests (~$cost @ $rate/GB)" summary.
export function formatBandwidth(bytes, count, costPerGb) {
  const base = `${formatBytes(bytes)} across ${count} request${count === 1 ? "" : "s"}`;
  if (!(costPerGb > 0)) return base;
  return `${base} (~$${estimateCost(bytes, costPerGb).toFixed(2)} @ $${costPerGb}/GB)`;
}

export class BandwidthMeter {
  constructor({ skip } = {}) {
    this._skip = skip || (() => false);
    this._bytes = 0;
    this._count = 0;
  }

  get bytes() {
    return this._bytes;
  }
  get count() {
    return this._count;
  }

  // Count one finished request's transferred bytes (headers + body, both ways).
  async _record(req) {
    try {
      if (this._skip(req.url())) return;
      const s = await req.sizes();
      if (!s) return;
      this._bytes +=
        (s.requestBodySize || 0) + (s.requestHeadersSize || 0) + (s.responseBodySize || 0) + (s.responseHeadersSize || 0);
      this._count++;
    } catch {
      /* a request whose sizes() is unavailable is simply not counted */
    }
  }

  attach(page) {
    page.on("requestfinished", (req) => this._record(req));
  }

  summary(costPerGb) {
    return formatBandwidth(this._bytes, this._count, costPerGb);
  }
}
