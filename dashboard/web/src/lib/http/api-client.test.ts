import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createApiClient } from "./api-client";
import { ApiError } from "./api-error";

const itemSchema = z.object({ id: z.number(), name: z.string() });

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeClient(fetchFn: typeof fetch, timeoutMs?: number) {
  return createApiClient({ baseUrl: "http://api.test", fetchFn, timeoutMs });
}

describe("createApiClient", () => {
  it("parses a valid JSON body against the schema", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: 1, name: "one" }));
    const data = await makeClient(fetchFn as unknown as typeof fetch).get(
      "/things/1",
      { schema: itemSchema },
    );
    expect(data).toEqual({ id: 1, name: "one" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://api.test/things/1");
  });

  it("appends query params", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: 1, name: "one" }));
    await makeClient(fetchFn as unknown as typeof fetch).get("/things", {
      schema: itemSchema,
      params: { q: "a b", n: 2 },
    });
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://api.test/things?q=a+b&n=2");
  });

  it("postForm sends FormData without a JSON Content-Type and parses the result", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: 7, name: "up" }));
    const form = new FormData();
    form.append("file", new File(["x"], "a.csv", { type: "text/csv" }));
    const data = await makeClient(fetchFn as unknown as typeof fetch).postForm(
      "/upload",
      { form, schema: itemSchema },
    );
    expect(data).toEqual({ id: 7, name: "up" });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe(form);
    // No explicit Content-Type — the browser sets the multipart boundary.
    expect(init.headers).toBeUndefined();
  });

  it("throws ApiError kind shape on a schema mismatch", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: "nope" }));
    const promise = makeClient(fetchFn as unknown as typeof fetch).get("/x", {
      schema: itemSchema,
    });
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ kind: "shape" });
  });

  it("throws ApiError kind http with status on a 409", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "conflict" }, { status: 409 }),
    );
    const promise = makeClient(fetchFn as unknown as typeof fetch).get("/x", {
      schema: itemSchema,
    });
    await expect(promise).rejects.toMatchObject({ kind: "http", status: 409 });
  });

  it("throws ApiError kind parse on invalid JSON", async () => {
    const fetchFn = vi.fn(async () => new Response("not json", { status: 200 }));
    const promise = makeClient(fetchFn as unknown as typeof fetch).get("/x", {
      schema: itemSchema,
    });
    await expect(promise).rejects.toMatchObject({ kind: "parse" });
  });

  it("throws ApiError kind network when fetch throws", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const promise = makeClient(fetchFn as unknown as typeof fetch).get("/x", {
      schema: itemSchema,
    });
    await expect(promise).rejects.toMatchObject({ kind: "network" });
  });

  it("throws ApiError kind timeout when the timeout fires", async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const promise = makeClient(fetchFn as unknown as typeof fetch, 10).get(
      "/x",
      { schema: itemSchema },
    );
    await expect(promise).rejects.toMatchObject({ kind: "timeout" });
  });

  it("re-throws a caller abort untouched", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const promise = makeClient(fetchFn as unknown as typeof fetch).get("/x", {
      schema: itemSchema,
      signal: controller.signal,
    });
    controller.abort();
    const error = await promise.catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ApiError);
    expect(controller.signal.aborted).toBe(true);
  });

  it("post sends a JSON body and validates the response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: 2, name: "two" }));
    const data = await makeClient(fetchFn as unknown as typeof fetch).post(
      "/things",
      { body: { name: "two" }, schema: itemSchema },
    );
    expect(data).toEqual({ id: 2, name: "two" });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://api.test/things");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ name: "two" }));
    expect(new Headers(init.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("post without a schema resolves undefined and tolerates an empty body", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    const data = await makeClient(fetchFn as unknown as typeof fetch).post(
      "/things/1/stop",
      { body: {} },
    );
    expect(data).toBeUndefined();
  });

  it("post maps a non-ok response to ApiError http", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "bad" }, { status: 400 }),
    );
    const promise = makeClient(fetchFn as unknown as typeof fetch).post("/x", {
      body: {},
      schema: itemSchema,
    });
    await expect(promise).rejects.toMatchObject({ kind: "http", status: 400 });
  });

  it("uses the server's JSON error text as the http error message", async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse({ error: "Cannot start a running run" }, { status: 409 }),
    );
    const promise = makeClient(fetchFn as unknown as typeof fetch).post("/x", {
      body: {},
    });
    await expect(promise).rejects.toMatchObject({
      kind: "http",
      status: 409,
      message: "Cannot start a running run",
    });
  });

  it("falls back to a generic message when the error body is unreadable", async () => {
    const fetchFn = vi.fn(
      async () => new Response("<html>boom</html>", { status: 500 }),
    );
    const promise = makeClient(fetchFn as unknown as typeof fetch).post("/x", {
      body: {},
    });
    await expect(promise).rejects.toMatchObject({
      kind: "http",
      status: 500,
      message: "Request failed (HTTP 500).",
    });
  });

  it("put sends a JSON body with PUT and validates the response", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: 1, name: "renamed" }));
    const data = await makeClient(fetchFn as unknown as typeof fetch).put(
      "/things/1",
      { body: { name: "renamed" }, schema: itemSchema },
    );
    expect(data).toEqual({ id: 1, name: "renamed" });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({ name: "renamed" });
  });

  it("patch sends a JSON body with PATCH and resolves undefined", async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ id: "1" }));
    const result = await makeClient(fetchFn as unknown as typeof fetch).patch(
      "/things/1",
      { body: { label: "x" } },
    );
    expect(result).toBeUndefined();
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://api.test/things/1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ label: "x" });
  });

  it("del issues a DELETE and resolves on success", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204 }));
    await makeClient(fetchFn as unknown as typeof fetch).del("/things/1", {});
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
  });

  it("del maps a 404 to ApiError http", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 404 }));
    const promise = makeClient(fetchFn as unknown as typeof fetch).del(
      "/things/9",
      {},
    );
    await expect(promise).rejects.toMatchObject({ kind: "http", status: 404 });
  });
});
