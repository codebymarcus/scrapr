import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { runKeys } from "./runs-keys";
import { useItemActions } from "./use-item-actions";

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function setup(respond: () => Response) {
  const fetchFn = vi.fn(async () => respond());
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
  const hook = renderHook(() => useItemActions(client), { wrapper });
  return { fetchFn, invalidate, ...hook };
}

function calledWith(fetchFn: ReturnType<typeof setup>["fetchFn"]) {
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
  return { url, method: init.method };
}

const run = { id: 5, project_id: 1, state: "stopped" };

function expectRefreshed(invalidate: ReturnType<typeof setup>["invalidate"]) {
  expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.detail(5) });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.lists() });
}

describe("useItemActions", () => {
  it("remove deletes the item and refreshes detail + lists", async () => {
    const { result, fetchFn, invalidate } = setup(json({ deleted: true }));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.remove.mutateAsync({ runId: 5, itemId: 9 });
    });

    expect(calledWith(fetchFn)).toEqual({
      url: "http://test.local/api/runs/5/items/9",
      method: "DELETE",
    });
    expect(outcome).toMatchObject({ ok: true });
    expectRefreshed(invalidate);
  });

  it("upload posts to the item upload endpoint and returns the Drive link", async () => {
    const { result, fetchFn, invalidate } = setup(
      json({ uploaded: true, driveLink: "https://drive.example/f/1" }),
    );

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.upload.mutateAsync({ runId: 5, itemId: 9 });
    });

    expect(calledWith(fetchFn)).toEqual({
      url: "http://test.local/api/runs/5/items/9/upload",
      method: "POST",
    });
    expect(outcome).toEqual({
      ok: true,
      data: { uploaded: true, driveLink: "https://drive.example/f/1" },
    });
    expectRefreshed(invalidate);
  });

  it("uploadPending posts to the bulk upload endpoint", async () => {
    const { result, fetchFn, invalidate } = setup(
      json({ uploaded: 2, skipped: 1, failed: 0 }),
    );

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.uploadPending.mutateAsync({ runId: 5 });
    });

    expect(calledWith(fetchFn)).toEqual({
      url: "http://test.local/api/runs/5/upload-pending",
      method: "POST",
    });
    expect(outcome).toEqual({
      ok: true,
      data: { uploaded: 2, skipped: 1, failed: 0 },
    });
    expectRefreshed(invalidate);
  });

  it("retry posts to the run retry endpoint", async () => {
    const { result, fetchFn, invalidate } = setup(json({ run }));

    await act(async () => {
      await result.current.retry.mutateAsync({ runId: 5 });
    });

    expect(calledWith(fetchFn)).toEqual({
      url: "http://test.local/api/runs/5/retry",
      method: "POST",
    });
    expectRefreshed(invalidate);
  });

  it("retryItem posts to the item retry endpoint", async () => {
    const { result, fetchFn, invalidate } = setup(json({ run }));

    await act(async () => {
      await result.current.retryItem.mutateAsync({ runId: 5, itemId: 9 });
    });

    expect(calledWith(fetchFn)).toEqual({
      url: "http://test.local/api/runs/5/items/9/retry",
      method: "POST",
    });
    expectRefreshed(invalidate);
  });

  it("resolves a 409 to an inline error with the server message", async () => {
    const message = "Google Drive is not connected";
    const { result } = setup(json({ error: message }, 409));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.upload.mutateAsync({ runId: 5, itemId: 9 });
    });

    expect(outcome).toEqual({ ok: false, error: message });
    expect(result.current.upload.isError).toBe(false);
  });

  it("still throws for non-409 failures", async () => {
    const { result } = setup(json({ error: "Item not found" }, 404));

    await act(async () => {
      await expect(
        result.current.remove.mutateAsync({ runId: 5, itemId: 9 }),
      ).rejects.toMatchObject({ kind: "http", status: 404 });
    });
  });
});
