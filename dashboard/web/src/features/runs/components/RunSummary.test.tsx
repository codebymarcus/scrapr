import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunSummary as Summary } from "@/lib/schemas";
import { formatBytes, formatDuration, RunSummary } from "./RunSummary";

const summary: Summary = {
  durationMs: 3_661_000,
  counts: { total: 15, completed: 12, failed: 1, skipped: 2, uploaded: 10 },
  pages: 240,
  uploadedSize: 1536,
  bytesDownloaded: 5 * 1024 * 1024,
  cost: 0,
};

describe("formatBytes", () => {
  it("picks the unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });

  it("handles unit boundaries", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1_048_575)).toBe("1 MB");
    expect(formatBytes(1_048_576)).toBe("1 MB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5 TB");
  });

  it("guards invalid input", () => {
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
  });
});

describe("formatDuration", () => {
  it("humanizes milliseconds", () => {
    expect(formatDuration(3_661_000)).toBe("1h 1m 1s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(999)).toBe("0s");
    expect(formatDuration(59_999)).toBe("59s");
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
  });
});

describe("RunSummary", () => {
  it("renders each stat humanized", () => {
    render(<RunSummary summary={summary} />);
    expect(screen.getByText("1h 1m 1s")).toBeInTheDocument();
    expect(
      screen.getByText(
        "12 completed · 1 failed · 2 skipped · 10 uploaded of 15",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("1.5 KB")).toBeInTheDocument();
    expect(screen.getByText("240")).toBeInTheDocument();
    expect(screen.getByText("5 MB")).toBeInTheDocument();
  });

  it("hides cost when it is zero", () => {
    render(<RunSummary summary={summary} />);
    expect(screen.queryByText(/est\./)).not.toBeInTheDocument();
  });

  it("shows an estimated cost when positive", () => {
    render(<RunSummary summary={{ ...summary, cost: 0.123 }} />);
    expect(screen.getByText("~$0.12 est.")).toBeInTheDocument();
  });

  it("shows a dash when the duration is unknown", () => {
    render(<RunSummary summary={{ ...summary, durationMs: null }} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
