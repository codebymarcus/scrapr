import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeRun } from "../test/fixtures";
import { RunCard } from "./RunCard";

describe("RunCard", () => {
  it("renders the name, state badge and content-type tag", () => {
    render(
      <RunCard
        run={makeRun({ id: 1, label: "Berserk vol 1", state: "running" })}
        contentType="image"
        progress={{ done: 3, total: 12 }}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Berserk vol 1" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("image")).toBeInTheDocument();
  });

  it("shows a progressbar with counts for a running run", () => {
    render(
      <RunCard
        run={makeRun({ id: 1, state: "running" })}
        progress={{ done: 3, total: 12 }}
      />,
    );

    const bar = screen.getByRole("progressbar", { name: "3 of 12" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "12");
    expect(screen.getByText("3 of 12 items")).toBeInTheDocument();
  });

  it("falls back to a progressbar without counts when progress is unknown", () => {
    render(<RunCard run={makeRun({ id: 1, state: "running" })} />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("omits the progressbar for a finished run without progress", () => {
    render(<RunCard run={makeRun({ id: 1, state: "done" })} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("falls back to a run number when there is no label", () => {
    render(<RunCard run={makeRun({ id: 7, label: null, state: "done" })} />);
    expect(screen.getByRole("heading", { name: "Run #7" })).toBeInTheDocument();
  });

  it("renders the actions slot", () => {
    render(
      <RunCard
        run={makeRun({ id: 1, state: "stopped" })}
        actions={<button type="button">Resume</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
  });
});
