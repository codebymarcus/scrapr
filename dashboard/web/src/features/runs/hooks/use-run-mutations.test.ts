import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { makeRun } from "../test/fixtures";
import { runKeys } from "./runs-keys";
import { useCreateRun, useEnqueue, useImport } from "./use-run-mutations";

function setup(respond: (url: string, init: RequestInit) => Response) {
  const fetchFn = vi.fn(async (url: string, init: RequestInit) =>
    respond(url, init),
  );
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { fetchFn, invalidate, client, wrapper };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function lastCall(fetchFn: ReturnType<typeof setup>["fetchFn"]) {
  const [url, init] = fetchFn.mock.calls.at(-1) as unknown as [
    string,
    RequestInit,
  ];
  return {
    url,
    method: init.method,
    body: init.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
  };
}

describe("useCreateRun", () => {
  it("posts the project and label, returns the run and invalidates lists", async () => {
    const run = makeRun({ id: 9, project_id: 4, label: "Batch" });
    const { fetchFn, invalidate, client, wrapper } = setup(() =>
      json({ run }, 201),
    );
    const { result } = renderHook(() => useCreateRun(client), { wrapper });

    let created: unknown;
    await act(async () => {
      created = await result.current.mutateAsync({
        projectId: 4,
        label: "Batch",
      });
    });

    expect(lastCall(fetchFn)).toEqual({
      url: "http://test.local/api/runs",
      method: "POST",
      body: { projectId: 4, label: "Batch" },
    });
    expect(created).toEqual(run);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.lists() });
  });

  it("omits an empty label", async () => {
    const { fetchFn, client, wrapper } = setup(() =>
      json({ run: makeRun({ id: 1 }) }, 201),
    );
    const { result } = renderHook(() => useCreateRun(client), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ projectId: 4 });
    });

    expect(lastCall(fetchFn).body).toEqual({ projectId: 4 });
  });
});

describe("useEnqueue", () => {
  it("posts the urls to the run's items endpoint", async () => {
    const { fetchFn, invalidate, client, wrapper } = setup(() =>
      json({ added: 2 }),
    );
    const { result } = renderHook(() => useEnqueue(client), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        runId: 7,
        urls: ["https://a.test/1", "https://a.test/2"],
      });
    });

    expect(lastCall(fetchFn)).toEqual({
      url: "http://test.local/api/runs/7/items",
      method: "POST",
      body: { urls: ["https://a.test/1", "https://a.test/2"] },
    });
    expect(outcome).toEqual({ ok: true, added: 2 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.all });
  });

  it("resolves a 409 to an inline error with the server message", async () => {
    const message =
      "Cannot add items to a running run (only queued or stopped runs accept items)";
    const { client, wrapper } = setup(() => json({ error: message }, 409));
    const { result } = renderHook(() => useEnqueue(client), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({
        runId: 7,
        urls: ["https://a.test/1"],
      });
    });

    expect(outcome).toEqual({ ok: false, error: message });
    expect(result.current.isError).toBe(false);
  });

  it("refuses an empty url list without calling the server", async () => {
    const { fetchFn, client, wrapper } = setup(() => json({ added: 0 }));
    const { result } = renderHook(() => useEnqueue(client), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ runId: 7, urls: [] }),
      ).rejects.toThrow(/at least one/i);
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("still throws for non-409 failures", async () => {
    const { client, wrapper } = setup(() =>
      json({ error: "Run not found" }, 404),
    );
    const { result } = renderHook(() => useEnqueue(client), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ runId: 7, urls: ["https://a.test/1"] }),
      ).rejects.toMatchObject({ kind: "http", status: 404 });
    });
  });
});

const makeSheet = () =>
  new File(["url\nhttps://a.test/1\n"], "links.csv", { type: "text/csv" });

function lastForm(fetchFn: ReturnType<typeof setup>["fetchFn"]): FormData {
  const [, init] = fetchFn.mock.calls.at(-1) as unknown as [string, RequestInit];
  return init.body as FormData;
}

describe("useImport", () => {
  it("uploads the file and run id and reports the added count", async () => {
    const { fetchFn, invalidate, client, wrapper } = setup(() =>
      json({ added: 12 }),
    );
    const { result } = renderHook(() => useImport(client), { wrapper });

    const file = makeSheet();
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({ file, runId: 3 });
    });

    const [url, init] = fetchFn.mock.calls.at(-1) as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://test.local/api/runs/import");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect((form.get("file") as File).name).toBe("links.csv");
    expect(form.get("runId")).toBe("3");
    expect(outcome).toEqual({ ok: true, added: 12 });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.all });
  });

  it("returns the parsed urls when no run is given (no runId field)", async () => {
    const { fetchFn, client, wrapper } = setup(() =>
      json({ urls: ["https://a.test/1"] }),
    );
    const { result } = renderHook(() => useImport(client), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({ file: makeSheet() });
    });

    const form = lastForm(fetchFn);
    expect((form.get("file") as File).name).toBe("links.csv");
    expect(form.get("runId")).toBeNull();
    expect(outcome).toEqual({ ok: true, urls: ["https://a.test/1"] });
  });

  it("resolves a 409 to an inline error", async () => {
    const { client, wrapper } = setup(() =>
      json({ error: "Cannot add items to a running run" }, 409),
    );
    const { result } = renderHook(() => useImport(client), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync({ file: makeSheet(), runId: 3 });
    });

    expect(outcome).toEqual({
      ok: false,
      error: "Cannot add items to a running run",
    });
  });

  it("throws for a 400 so the dialog can show the server message", async () => {
    const { client, wrapper } = setup(() =>
      json({ error: "Unsupported file type" }, 400),
    );
    const { result } = renderHook(() => useImport(client), { wrapper });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ file: makeSheet() }),
      ).rejects.toMatchObject({
        status: 400,
        message: "Unsupported file type",
      });
    });
  });
});
