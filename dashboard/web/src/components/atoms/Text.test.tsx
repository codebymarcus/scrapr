import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Text } from "./Text";

describe("Text", () => {
  it("renders an h1 with the display class for variant display", () => {
    render(<Text variant="display">Title</Text>);
    const heading = screen.getByRole("heading", { level: 1, name: "Title" });
    expect(heading.className).toMatch(/display/);
  });

  it("renders a paragraph with the body class by default", () => {
    render(<Text>Hello</Text>);
    const el = screen.getByText("Hello");
    expect(el.tagName).toBe("P");
    expect(el.className).toMatch(/body/);
  });

  it("maps each variant to its own class", () => {
    render(
      <>
        <Text variant="title">T</Text>
        <Text variant="small">S</Text>
        <Text variant="caption">C</Text>
      </>,
    );
    expect(screen.getByText("T").className).toMatch(/title/);
    expect(screen.getByText("S").className).toMatch(/small/);
    expect(screen.getByText("C").className).toMatch(/caption/);
  });

  it("lets `as` override the element", () => {
    render(
      <Text variant="title" as="h3">
        Section
      </Text>,
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "Section" }),
    ).toBeInTheDocument();
  });

  it("applies tone and weight classes", () => {
    render(
      <Text tone="negative" weight="bold">
        Bad
      </Text>,
    );
    const el = screen.getByText("Bad");
    expect(el.className).toMatch(/tone-negative/);
    expect(el.className).toMatch(/weight-bold/);
  });

  it("forwards passthrough attributes like role", () => {
    render(
      <Text variant="small" role="status">
        Loading
      </Text>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
  });
});
