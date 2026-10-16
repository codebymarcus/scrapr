import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { makeProject } from "@/test/fixtures";
import { makeRun } from "../test/fixtures";
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

const sheetFile = () =>
  new File(["url\nhttps://a.test/1\n"], "links.csv", { type: "text/csv" });

// A multipart import body is recorded as { file: <filename>, runId? }; JSON
// bodies (run create, enqueue) are parsed as before.
function readBody(init: RequestInit | undefined): unknown {
  if (!init?.body) return undefined;
  if (init.body instanceof FormData) {
    const file = init.body.get("file");
    const runId = init.body.get("runId");
    return {
      file: file instanceof File ? file.name : null,
      ...(runId === null ? {} : { runId }),
    };
  }
  return JSON.parse(String(init.body)) as unknown;
}

function setup(handlers: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const call: Call = { path, method, body: readBody(init) };
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
  it("uploads into an existing queued run and reports the added count", async () => {
    const { writes } = setup({
      "POST /api/runs/import": () => json({ added: 12 }),
    });

    await screen.findByRole("option", { name: /Open run/ });
    // Running runs cannot take new items.
    expect(
      screen.queryByRole("option", { name: /Busy run/ }),
    ).not.toBeInTheDocument();
    await userEvent.upload(
      screen.getByLabelText("Spreadsheet file"),
      sheetFile(),
    );
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
        body: { file: "links.csv", runId: "3" },
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

    await userEvent.upload(
      screen.getByLabelText("Spreadsheet file"),
      sheetFile(),
    );
    await screen.findByRole("option", { name: "Alpha" });
    await userEvent.selectOptions(screen.getByLabelText("Project"), "Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Added 2 URLs to run #8.",
    );
    expect(writes().map((call) => [call.path, call.body])).toEqual([
      ["/api/runs/import", { file: "links.csv" }],
      ["/api/runs", { projectId: 5 }],
      ["/api/runs/8/items", { urls: ["https://a.test/1", "https://a.test/2"] }],
    ]);
  });

  it("shows the server error and creates no run when the sheet is bad", async () => {
    const { writes } = setup({
      "POST /api/runs/import": () =>
        json({ error: "Unsupported file type" }, 400),
    });

    await userEvent.upload(
      screen.getByLabelText("Spreadsheet file"),
      sheetFile(),
    );
    await screen.findByRole("option", { name: "Alpha" });
    await userEvent.selectOptions(screen.getByLabelText("Project"), "Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Unsupported file type",
    );
    expect(writes().map((call) => call.path)).toEqual(["/api/runs/import"]);
  });

  it("shows a 409 when the chosen run started in the meantime", async () => {
    setup({
      "POST /api/runs/import": () =>
        json({ error: "Cannot add items to a running run" }, 409),
    });

    await screen.findByRole("option", { name: /Open run/ });
    await userEvent.upload(
      screen.getByLabelText("Spreadsheet file"),
      sheetFile(),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Add to"),
      screen.getByRole("option", { name: /Open run/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot add items to a running run",
    );
  });

  it("requires a file", async () => {
    const { writes } = setup();

    await userEvent.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a spreadsheet file to upload.",
    );
    expect(writes()).toEqual([]);
  });
});
