import { createApiClient } from "@/lib/http/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import type { Run, RunItem, RunSummary } from "@/lib/schemas";

export function makeRun(overrides: Partial<Run> & { id: number }): Run {
  return {
    project_id: 1,
    label: `Run ${overrides.id}`,
    state: "queued",
    created_at: "2026-10-16T08:00:00.000Z",
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

export function makeItem(
  overrides: Partial<RunItem> & { id: number; run_id: number },
): RunItem {
  return {
    url: `https://example.com/${overrides.id}`,
    name: null,
    status: "",
    saved: null,
    total: null,
    ...overrides,
  };
}

export function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    durationMs: 45_000,
    counts: { total: 0, completed: 0, failed: 0, skipped: 0, uploaded: 0 },
    pages: 0,
    uploadedSize: 0,
    bytesDownloaded: 0,
    cost: 0,
    ...overrides,
  };
}

type Routes = Record<string, unknown | (() => Response)>;

// A real api client whose fetch is a stub keyed by request path.
export function makeFakeClient(routes: Routes): ApiClient {
  const fetchFn: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (!(path in routes)) {
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
      });
    }
    const body = routes[path];
    if (typeof body === "function") {
      return (body as () => Response)();
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return createApiClient({ baseUrl: "http://test.local", fetchFn });
}
