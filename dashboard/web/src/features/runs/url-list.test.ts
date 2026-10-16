import { describe, expect, it } from "vitest";
import { describeInvalidLines, parseUrlList } from "./url-list";

describe("parseUrlList", () => {
  it("splits lines, trims them and drops blanks", () => {
    expect(
      parseUrlList("  https://a.test/1 \n\n\r\nhttp://b.test/2\n"),
    ).toEqual({ urls: ["https://a.test/1", "http://b.test/2"], invalid: [] });
  });

  it("flags lines that are not http(s) urls", () => {
    expect(
      parseUrlList("https://a.test/1\nftp://b.test\nexample.com\njavascript:alert(1)"),
    ).toEqual({
      urls: ["https://a.test/1"],
      invalid: [
        { line: 2, text: "ftp://b.test" },
        { line: 3, text: "example.com" },
        { line: 4, text: "javascript:alert(1)" },
      ],
    });
  });

  it("treats blank input as an empty list", () => {
    expect(parseUrlList(" \n \n")).toEqual({ urls: [], invalid: [] });
  });
});

describe("describeInvalidLines", () => {
  it("names the first bad line and counts the rest", () => {
    expect(describeInvalidLines([{ line: 2, text: "x" }])).toBe(
      "Line 2 must start with http:// or https://.",
    );
    expect(
      describeInvalidLines([
        { line: 2, text: "x" },
        { line: 5, text: "y" },
      ]),
    ).toBe(
      "Line 2 must start with http:// or https:// (and 1 more line is invalid).",
    );
  });
});
