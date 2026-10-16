import { describe, expect, it } from "vitest";
import { normalizeTextFields } from "./text-fields";

describe("normalizeTextFields", () => {
  it("reads selector/pattern fields, joining list values", () => {
    expect(
      normalizeTextFields([
        { name: "title", value: "Hello" },
        { name: "tags", value: ["a", "b"] },
        { name: "broken" },
        "junk",
      ]),
    ).toEqual([
      { name: "title", value: "Hello" },
      { name: "tags", value: "a\nb" },
    ]);
  });

  it("reads article fields in a fixed order, skipping empty ones", () => {
    expect(
      normalizeTextFields({
        markdown: "# Body",
        title: "Hello",
        byline: "",
        excerpt: "Short",
      }),
    ).toEqual([
      { name: "title", value: "Hello" },
      { name: "excerpt", value: "Short" },
      { name: "markdown", value: "# Body" },
    ]);
  });

  it("returns nothing for unrecognized shapes", () => {
    expect(normalizeTextFields(undefined)).toEqual([]);
    expect(normalizeTextFields("text")).toEqual([]);
    expect(normalizeTextFields(null)).toEqual([]);
  });
});
