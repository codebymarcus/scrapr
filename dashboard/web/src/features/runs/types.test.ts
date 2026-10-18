import { describe, expect, it } from "vitest";
import type { RunItem } from "@/lib/schemas";
import { deriveItemStatus, isUploaded } from "./types";

const item = (over: Partial<RunItem> = {}): RunItem => ({
  id: 1,
  run_id: 1,
  url: "https://x/1",
  status: "queued",
  ...over,
});

describe("deriveItemStatus", () => {
  it("is completed when saved is set and status is done", () => {
    expect(deriveItemStatus(item({ status: "done", saved: 3 }))).toBe("completed");
    expect(deriveItemStatus(item({ status: "done", saved: 0 }))).toBe("completed");
  });

  it("is pending when nothing has been recorded", () => {
    expect(deriveItemStatus(item())).toBe("pending");
    expect(deriveItemStatus(item({ status: "done", saved: null }))).toBe("pending");
  });

  it("is failed for a retry status", () => {
    expect(deriveItemStatus(item({ status: "retry" }))).toBe("failed");
  });

  it("is failed when a reason is recorded and it did not complete", () => {
    expect(deriveItemStatus(item({ status: "failed", reason: "timeout" }))).toBe("failed");
    expect(deriveItemStatus(item({ status: "done", saved: null, reason: "boom" }))).toBe(
      "failed",
    );
  });

  it("is skipped for a skip status or a skipped: reason", () => {
    expect(deriveItemStatus(item({ status: "skip" }))).toBe("skipped");
    expect(
      deriveItemStatus(item({ status: "done", reason: "skipped: already have it" })),
    ).toBe("skipped");
  });

  it("does not treat a reason on a completed item as a failure", () => {
    expect(
      deriveItemStatus(item({ status: "done", saved: 2, reason: "partial" })),
    ).toBe("completed");
  });
});

describe("isUploaded", () => {
  it("reflects uploaded_at", () => {
    expect(isUploaded(item({ uploaded_at: "2026-10-18T00:00:00Z" }))).toBe(true);
    expect(isUploaded(item({ uploaded_at: null }))).toBe(false);
    expect(isUploaded(item())).toBe(false);
  });
});
