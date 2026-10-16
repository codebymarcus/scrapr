import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { makeProject, makeRun } from "../test/fixtures";
import { ImportListDialog } from "./ImportListDialog";

type Call = { path: string; method: string; body?: unknown };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const runs = [
  makeRun({ id: 1, label: "Open run", state: "queued" }),
  makeRun({ id: 2, label: "Busy run", state: "running" }),
  makeRun({ id: 3, label: "Paused run", state: "stopped" }),
];

function setup(handlers: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const call: Call = {
      path,
      method,
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
    };
    calls.push(call);
    const handler = handlers[`${method} ${path}`];
    if (handler) return handler(call);
    if (path === "/api/runs" && method === "GET") return json({ runs });
    if (path === "/api/projects") {
      return json({ projects: [makeProject({ id: 5, name: "Alpha" })] });
    }
    return json({ error: "not found" }, 404);
  };
  const client = createApiClient({ baseUrl: "http://test.local", fetchFn });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <ImportListDialog client={client} onClose={onClose} />
    </QueryClientProvider>,
  );
  const writes = () => calls.filter((call) => call.method === "POST");
  return { writes, onClose };
}

describe("ImportListDialog", () => {
  it("imports into an existing queued run and reports the added count", async () => {
    const { writes } = setup({
      "POST /api/runs/import": () => json({ added: 12 }),
    });

    await screen.findByRole("option", { name: /Open run/ });
    // Running runs cannot take new items.
    expect(
      screen.queryByRole("option", { name: /Busy run/ }),
    ).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Sheet path"), "/data/links.csv");
    await userEvent.selectOptions(
      screen.getByLabelText("Add to"),
      screen.getByRole("option", { name: /Paused run/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Added 12 URLs to run #3.",
    );
    expect(writes()).toEqual([
      {
        path: "/api/runs/import",
        method: "POST",
        body: { path: "/data/links.csv", runId: 3 },
      },
    ]);
  });

  it("reads the sheet, then creates a run and enqueues its urls", async () => {
    const { writes } = setup({
      "POST /api/runs/import": () =>
        json({ urls: ["https://a.test/1", "https://a.test/2"] }),
      "POST /api/runs": () =>
        json({ run: makeRun({ id: 8, project_id: 5 }) }, 201),
      "POST /api/runs/8/items": () => json({ added: 2 }),
    });

    await userEvent.type(screen.getByLabelText("Sheet path"), "/data/links.csv");
    await screen.findByRole("option", { name: "Alpha" });
    await userEvent.selectOptions(screen.getByLabelText("Project"), "Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Added 2 URLs to run #8.",
    );
    expect(writes().map((call) => [call.path, call.body])).toEqual([
      ["/api/runs/import", { path: "/data/links.csv" }],
      ["/api/runs", { projectId: 5 }],
      ["/api/runs/8/items", { urls: ["https://a.test/1", "https://a.test/2"] }],
    ]);
  });

  it("shows the server error and creates no run when the sheet is bad", async () => {
    const { writes } = setup({
      "POST /api/runs/import": () =>
        json({ error: "File not found or unreadable" }, 400),
    });

    await userEvent.type(screen.getByLabelText("Sheet path"), "/nope.csv");
    await screen.findByRole("option", { name: "Alpha" });
    await userEvent.selectOptions(screen.getByLabelText("Project"), "Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "File not found or unreadable",
    );
    expect(writes().map((call) => call.path)).toEqual(["/api/runs/import"]);
  });

  it("shows a 409 when the chosen run started in the meantime", async () => {
    setup({
      "POST /api/runs/import": () =>
        json({ error: "Cannot add items to a running run" }, 409),
    });

    await screen.findByRole("option", { name: /Open run/ });
    await userEvent.type(screen.getByLabelText("Sheet path"), "/data/links.csv");
    await userEvent.selectOptions(
      screen.getByLabelText("Add to"),
      screen.getByRole("option", { name: /Open run/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot add items to a running run",
    );
  });

  it("requires a path", async () => {
    const { writes } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter the path to a sheet.",
    );
    expect(writes()).toEqual([]);
  });
});
