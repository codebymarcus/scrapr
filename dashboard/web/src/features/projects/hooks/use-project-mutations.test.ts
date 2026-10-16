import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { makeProject } from "@/test/fixtures";
import { projectKeys } from "./projects-keys";
import {
  useCreateProject,
  useDeleteProject,
  useUpdateProject,
} from "./use-project-mutations";

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

describe("useCreateProject", () => {
  it("posts the name and recipe, returns the project and invalidates", async () => {
    const project = makeProject({ id: 4, name: "Manga" });
    const { fetchFn, invalidate, client, wrapper } = setup(() =>
      json({ project }, 201),
    );
    const { result } = renderHook(() => useCreateProject(client), { wrapper });

    let created: unknown;
    await act(async () => {
      created = await result.current.mutateAsync({
        name: "Manga",
        recipe: project.recipe,
      });
    });

    expect(lastCall(fetchFn)).toEqual({
      url: "http://test.local/api/projects",
      method: "POST",
      body: { name: "Manga", recipe: project.recipe },
    });
    expect(created).toEqual(project);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectKeys.all });
  });
});

describe("useUpdateProject", () => {
  it("puts the changes to the project's endpoint", async () => {
    const project = makeProject({ id: 4, name: "Renamed" });
    const { fetchFn, invalidate, client, wrapper } = setup(() =>
      json({ project }),
    );
    const { result } = renderHook(() => useUpdateProject(client), { wrapper });

    let updated: unknown;
    await act(async () => {
      updated = await result.current.mutateAsync({
        id: 4,
        changes: { name: "Renamed" },
      });
    });

    expect(lastCall(fetchFn)).toEqual({
      url: "http://test.local/api/projects/4",
      method: "PUT",
      body: { name: "Renamed" },
    });
    expect(updated).toEqual(project);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectKeys.all });
  });
});

describe("useDeleteProject", () => {
  it("deletes the project and invalidates", async () => {
    const { fetchFn, invalidate, client, wrapper } = setup(
      () => new Response(null, { status: 204 }),
    );
    const { result } = renderHook(() => useDeleteProject(client), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync(4);
    });

    expect(lastCall(fetchFn)).toMatchObject({
      url: "http://test.local/api/projects/4",
      method: "DELETE",
    });
    expect(outcome).toEqual({ ok: true });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: projectKeys.all });
  });

  it("resolves a 409 (project has runs) to an inline error", async () => {
    const message =
      "Project has runs and cannot be deleted. Delete its runs first.";
    const { client, wrapper } = setup(() => json({ error: message }, 409));
    const { result } = renderHook(() => useDeleteProject(client), { wrapper });

    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.mutateAsync(4);
    });

    expect(outcome).toEqual({ ok: false, error: message });
    expect(result.current.isError).toBe(false);
  });

  it("still throws for non-409 failures", async () => {
    const { client, wrapper } = setup(() =>
      json({ error: "Project not found" }, 404),
    );
    const { result } = renderHook(() => useDeleteProject(client), { wrapper });

    await act(async () => {
      await expect(result.current.mutateAsync(4)).rejects.toMatchObject({
        kind: "http",
        status: 404,
      });
    });
  });
});
