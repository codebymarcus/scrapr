import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { runKeys } from "./runs-keys";
import { useRunActions } from "./use-run-actions";

function setup(
  respond: () => Response,
  onFailure?: (id: number, message: string) => void,
) {
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
  const hook = renderHook(() => useRunActions(client, { onFailure }), { wrapper });
  return { fetchFn, invalidate, ...hook };
}

const ok = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const conflict = (error: string) => () =>
  new Response(JSON.stringify({ error }), { status: 409 });

function calledWith(fetchFn: ReturnType<typeof setup>["fetchFn"]) {
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
  return { url, method: init.method };
}

describe("useRunActions", () => {
  it("start posts to the start endpoint and invalidates the run cache", async () => {
    const { result, fetchFn, invalidate } = setup(ok);

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.start.mutateAsync(5);
    });

    expect(calledWith(fetchFn)).toEqual({
      url: "http://test.local/api/runs/5/start",
      method: "POST",
    });
    expect(outcome).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.all });
  });

  it("stop posts to the stop endpoint", async () => {
    const { result, fetchFn } = setup(ok);

    await act(async () => {
      await result.current.stop.mutateAsync(5);
    });

    expect(calledWith(fetchFn).url).toBe("http://test.local/api/runs/5/stop");
  });

  it("resume uses the start endpoint", async () => {
    const { result, fetchFn } = setup(ok);

    await act(async () => {
      await result.current.resume.mutateAsync(5);
    });

    expect(calledWith(fetchFn).url).toBe("http://test.local/api/runs/5/start");
  });

  it("resolves a 409 to an inline error with the server message, not a throw", async () => {
    const message = "Cannot start a running run (only queued or stopped runs can be started)";
    const { result, invalidate } = setup(conflict(message));

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.start.mutateAsync(5);
    });

    expect(outcome).toEqual({ ok: false, error: message });
    expect(result.current.start.isError).toBe(false);
    // State is probably stale, so refresh it.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.all });
  });

  it("reports a 409 message through onFailure", async () => {
    const onFailure = vi.fn();
    const { result } = setup(conflict("Run is not running"), onFailure);

    await act(async () => {
      await result.current.stop.mutateAsync(5);
    });

    expect(onFailure).toHaveBeenCalledWith(5, "Run is not running");
  });

  it("still throws for non-409 failures", async () => {
    const { result } = setup(
      () => new Response(JSON.stringify({ error: "Run not found" }), { status: 404 }),
    );

    await act(async () => {
      await expect(result.current.stop.mutateAsync(5)).rejects.toMatchObject({
        kind: "http",
        status: 404,
        message: "Run not found",
      });
    });
  });
});
