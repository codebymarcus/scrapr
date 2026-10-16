import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import type { Recipe } from "@/lib/schemas";
import { usePreviewImage, usePreviewText } from "./use-preview";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function setup(respond: () => Response) {
  const fetchFn = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () => respond(),
  );
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { fetchFn, client, wrapper };
}

function lastCall(fetchFn: ReturnType<typeof setup>["fetchFn"]) {
  const [url, init] = fetchFn.mock.calls.at(-1)!;
  return {
    url,
    method: init.method,
    body: JSON.parse(String(init.body)) as unknown,
  };
}

const recipe: Recipe = {
  name: "preview",
  contentType: "image",
  image: { rules: { minWidth: 400 }, pipeline: [] },
};

describe("usePreviewImage", () => {
  it("posts {url, recipe} and surfaces images and unenforcedRuleKeys", async () => {
    const { fetchFn, client, wrapper } = setup(() =>
      json({
        status: "ok",
        via: "browser",
        images: [{ url: "https://x.test/a.jpg", width: 800, height: 1200 }],
        unenforcedRuleKeys: ["excludeSelector"],
      }),
    );
    const { result } = renderHook(() => usePreviewImage(client), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ url: "https://x.test/p", recipe });
    });

    expect(lastCall(fetchFn)).toEqual({
      url: "http://test.local/api/preview/image",
      method: "POST",
      body: { url: "https://x.test/p", recipe },
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.images).toHaveLength(1);
    expect(result.current.data?.unenforcedRuleKeys).toEqual(["excludeSelector"]);
  });

  it("keeps the code and message of a failed preview", async () => {
    const { client, wrapper } = setup(() =>
      json({ status: "fail", code: "HTTP_ERROR", message: "403", images: [] }),
    );
    const { result } = renderHook(() => usePreviewImage(client), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ url: "https://x.test/p", recipe });
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toMatchObject({
      status: "fail",
      code: "HTTP_ERROR",
      message: "403",
    });
  });
});

describe("usePreviewText", () => {
  it("posts {url, recipe} to the text endpoint", async () => {
    const { fetchFn, client, wrapper } = setup(() =>
      json({
        status: "ok",
        via: "http",
        mode: "article",
        fields: { title: "Hello" },
      }),
    );
    const textRecipe: Recipe = {
      name: "preview",
      contentType: "text",
      text: { mode: "article" },
    };
    const { result } = renderHook(() => usePreviewText(client), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        url: "https://x.test/p",
        recipe: textRecipe,
      });
    });

    expect(lastCall(fetchFn)).toEqual({
      url: "http://test.local/api/preview/text",
      method: "POST",
      body: { url: "https://x.test/p", recipe: textRecipe },
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.fields).toEqual({ title: "Hello" });
  });
});
