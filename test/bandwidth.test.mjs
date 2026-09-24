// BandwidthMeter: transferred-byte accounting for proxy-cost estimation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BandwidthMeter, formatBytes, estimateCost } from "../src/bandwidth.mjs";

const fakeReq = (url, sizes) => ({ url: () => url, sizes: async () => sizes });
const S = (responseBodySize, extra = 0) => ({
  requestBodySize: 0, requestHeadersSize: extra, responseBodySize, responseHeadersSize: 0
});

test("formatBytes: decimal units (matches how proxies bill)", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(12345), "12.3 KB");
  assert.equal(formatBytes(12_345_678), "12.3 MB");
  assert.equal(formatBytes(1_500_000_000), "1.50 GB");
});

test("estimateCost: bytes / 1e9 * rate", () => {
  assert.equal(estimateCost(1_000_000_000, 4), 4);
  assert.equal(estimateCost(500_000_000, 4), 2);
});

test("meter: sums transferred bytes across finished requests", async () => {
  const m = new BandwidthMeter();
  await m._record(fakeReq("https://x/a", S(1000, 100)));
  await m._record(fakeReq("https://x/b", S(2000, 100)));
  assert.equal(m.bytes, 3200);
  assert.equal(m.count, 2);
});

test("meter: excludes requests served from the local cache", async () => {
  const served = new Set(["https://x/cached.jpg"]);
  const m = new BandwidthMeter({ skip: (u) => served.has(u) });
  await m._record(fakeReq("https://x/cached.jpg", S(999999)));
  await m._record(fakeReq("https://x/live.jpg", S(1000)));
  assert.equal(m.bytes, 1000);
  assert.equal(m.count, 1);
});

test("meter: tolerates sizes() failing", async () => {
  const m = new BandwidthMeter();
  await m._record({ url: () => "https://x/z", sizes: async () => { throw new Error("gone"); } });
  assert.equal(m.bytes, 0);
  assert.equal(m.count, 0);
});

test("summary: volume only when no rate given", () => {
  const m = new BandwidthMeter();
  m._bytes = 12_345_678; m._count = 57;
  assert.equal(m.summary(), "12.3 MB across 57 requests");
});

test("summary: adds a cost estimate when a rate is given", () => {
  const m = new BandwidthMeter();
  m._bytes = 12_345_678; m._count = 57;
  assert.equal(m.summary(4), "12.3 MB across 57 requests (~$0.05 @ $4/GB)");
});

test("formatBandwidth: shared formatter used by per-job and batch totals", async () => {
  const { formatBandwidth } = await import("../src/bandwidth.mjs");
  assert.equal(formatBandwidth(1_000_000, 1, null), "1.0 MB across 1 request");
  assert.equal(formatBandwidth(2_000_000_000, 120, 4), "2.00 GB across 120 requests (~$8.00 @ $4/GB)");
});
