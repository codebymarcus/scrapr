import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LogLine } from "../types";
import { RunConsole } from "./RunConsole";

const logs: LogLine[] = [
  { seq: 1, level: "section", message: "Starting scrape" },
  { seq: 2, level: "info", message: "Fetching chapter 1" },
  { seq: 3, level: "success", message: "Uploaded page-01.jpg to Drive" },
  { seq: 4, level: "error", message: "Upload failed: quota exceeded" },
];

describe("RunConsole", () => {
  it("renders each message in order", () => {
    render(<RunConsole logs={logs} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(
      logs.map((l) => l.message),
    );
  });

  it("styles an error line with the error class", () => {
    render(<RunConsole logs={logs} />);
    expect(screen.getByText("Upload failed: quota exceeded").className).toMatch(
      /error/,
    );
    expect(screen.getByText("Fetching chapter 1").className).not.toMatch(
      /error/,
    );
  });

  it("styles success lines with the success class", () => {
    render(<RunConsole logs={logs} />);
    expect(
      screen.getByText("Uploaded page-01.jpg to Drive").className,
    ).toMatch(/success/);
  });

  it("shows an empty state when there are no logs", () => {
    render(<RunConsole logs={[]} />);
    expect(screen.getByText(/no output yet/i)).toBeInTheDocument();
  });

  it("renders without layout (jsdom) and tolerates scrolling", () => {
    const { rerender } = render(<RunConsole logs={logs} />);
    fireEvent.scroll(screen.getByRole("log"));
    rerender(
      <RunConsole logs={[...logs, { seq: 5, message: "More output" }]} />,
    );
    expect(screen.getByText("More output")).toBeInTheDocument();
  });
});
