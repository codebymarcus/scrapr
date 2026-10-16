import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./Badge";

describe("Badge", () => {
  it.each([
    ["queued", "Queued"],
    ["running", "Running"],
    ["stopped", "Stopped"],
    ["done", "Done"],
    ["failed", "Failed"],
    ["review", "Review"],
  ] as const)("renders the %s tone with its label and class", (tone, label) => {
    render(<Badge tone={tone} />);
    const badge = screen.getByText(label);
    expect(badge.className).toMatch(new RegExp(tone));
  });
});
