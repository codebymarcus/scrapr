import { describe, expect, it } from "vitest";
import { deriveWsBase } from "./ws-base";

describe("deriveWsBase", () => {
  it("prefers an explicit VITE_WS_BASE", () => {
    expect(
      deriveWsBase({
        VITE_WS_BASE: "wss://ws.example.com",
        VITE_API_BASE: "https://api.example.com",
      }),
    ).toBe("wss://ws.example.com");
  });

  it("derives ws from an http API base", () => {
    expect(deriveWsBase({ VITE_API_BASE: "http://10.0.0.5:9000" })).toBe(
      "ws://10.0.0.5:9000",
    );
  });

  it("derives wss from an https API base and trims a trailing slash", () => {
    expect(deriveWsBase({ VITE_API_BASE: "https://api.example.com/" })).toBe(
      "wss://api.example.com",
    );
  });

  it("falls back to localhost when nothing is configured", () => {
    expect(deriveWsBase({})).toBe("ws://localhost:5174");
  });
});
