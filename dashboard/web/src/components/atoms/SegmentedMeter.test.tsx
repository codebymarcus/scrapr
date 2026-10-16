import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SegmentedMeter } from "./SegmentedMeter";

function litCount(): number {
  return screen
    .getByRole("progressbar")
    .querySelectorAll("[data-lit='true']").length;
}

describe("SegmentedMeter", () => {
  it("lights round(value/total*segments) blocks", () => {
    render(<SegmentedMeter value={50} total={100} segments={22} />);
    expect(litCount()).toBe(11);
  });

  it("rounds to the nearest block", () => {
    render(<SegmentedMeter value={1} total={3} segments={22} />);
    expect(litCount()).toBe(Math.round((1 / 3) * 22));
  });

  it("renders the requested number of segments", () => {
    render(<SegmentedMeter value={0} total={10} segments={10} />);
    expect(
      screen.getByRole("progressbar").querySelectorAll("[data-lit]"),
    ).toHaveLength(10);
  });

  it("exposes aria-valuenow and aria-valuemax", () => {
    render(<SegmentedMeter value={7} total={20} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "7");
    expect(bar).toHaveAttribute("aria-valuemax", "20");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
  });

  it("lights none when total is 0", () => {
    render(<SegmentedMeter value={5} total={0} />);
    expect(litCount()).toBe(0);
  });

  it("clamps to all segments when value exceeds total", () => {
    render(<SegmentedMeter value={30} total={10} segments={22} />);
    expect(litCount()).toBe(22);
  });
});
