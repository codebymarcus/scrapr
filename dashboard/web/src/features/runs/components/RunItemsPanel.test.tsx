import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import type { RunItem } from "@/lib/schemas";
import { makeItem } from "../test/fixtures";
import type { RunContentType } from "../types";
import { RunItemsPanel } from "./RunItemsPanel";

const RUN_ID = 7;
const RUN = {
  id: RUN_ID,
  project_id: 1,
  label: "Run",
  state: "stopped",
  created_at: "2026-10-16T08:00:00.000Z",
  started_at: null,
  finished_at: null,
};

type Call = { method: string; path: string };

function makeClient(conflict?: string) {
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ method: init?.method ?? "GET", path });
    if (conflict) {
      return new Response(JSON.stringify({ error: conflict }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }
    let body: unknown = {};
    if (path.endsWith("/upload-pending")) {
      body = { uploaded: 1, skipped: 0, failed: 0 };
    } else if (path.endsWith("/upload")) {
      body = { uploaded: true };
    } else if (path.endsWith("/retry")) {
      body = { run: RUN };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, calls };
}

function item(id: number, overrides: Partial<RunItem> = {}): RunItem {
  return makeItem({ id, run_id: RUN_ID, ...overrides });
}

const completedUploaded = item(1, {
  name: "alpha",
  status: "done",
  saved: 3,
  total: 3,
  uploaded_at: "2026-10-16T09:00:00.000Z",
  drive_link: "https://drive.example/alpha",
});
const completedPending = item(2, {
  name: "bravo",
  status: "done",
  saved: 2,
  total: 2,
});
const failed = item(3, { name: "charlie", status: "retry", reason: "timeout" });
const pending = item(4, { name: "delta" });
const skipped = item(5, { name: "echo", status: "skip", reason: "skipped: dup" });
const SAMPLE = [completedUploaded, completedPending, failed, pending, skipped];

function renderPanel(
  props: {
    items?: RunItem[];
    contentType?: RunContentType;
    isRunning?: boolean;
    conflict?: string;
  } = {},
) {
  const { client, calls } = makeClient(props.conflict);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RunItemsPanel
        runId={RUN_ID}
        items={props.items ?? SAMPLE}
        contentType={props.contentType ?? "image"}
        isRunning={props.isRunning ?? false}
        client={client}
      />
    </QueryClientProvider>,
  );
  return { calls };
}

function rowFor(name: string) {
  return screen.getByRole("row", { name: new RegExp(name) });
}

describe("RunItemsPanel", () => {
  it("renders a status badge per item and the name or URL", () => {
    renderPanel({ items: [...SAMPLE, item(6)] });

    expect(within(rowFor("alpha")).getByText("Completed")).toBeInTheDocument();
    expect(within(rowFor("charlie")).getByText("Failed")).toBeInTheDocument();
    expect(within(rowFor("delta")).getByText("Pending")).toBeInTheDocument();
    expect(within(rowFor("echo")).getByText("Skipped")).toBeInTheDocument();
    // An unnamed item falls back to its URL.
    expect(screen.getByText("https://example.com/6")).toBeInTheDocument();
  });

  it("renders an upload badge for image runs", () => {
    renderPanel();

    expect(within(rowFor("alpha")).getByText("Uploaded")).toBeInTheDocument();
    expect(
      within(rowFor("bravo")).getByText("Not uploaded"),
    ).toBeInTheDocument();
  });

  it("hides the upload badge and actions for text runs", () => {
    renderPanel({ contentType: "text" });

    expect(screen.queryByText("Uploaded")).not.toBeInTheDocument();
    expect(screen.queryByText("Not uploaded")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upload/i }),
    ).not.toBeInTheDocument();
    // Retry still applies to text runs.
    expect(
      within(rowFor("charlie")).getByRole("button", { name: /retry/i }),
    ).toBeInTheDocument();
  });

  it("shows the failure reason on a failed row", () => {
    renderPanel();

    expect(within(rowFor("charlie")).getByText("timeout")).toBeInTheDocument();
    expect(within(rowFor("bravo")).queryByText("timeout")).toBeNull();
  });

  it("offers the right action for each row state", () => {
    renderPanel();

    const buttonNames = (name: string) =>
      within(rowFor(name))
        .queryAllByRole("button")
        .map((button) => button.textContent);

    expect(buttonNames("alpha")).toEqual([]);
    expect(buttonNames("bravo")).toEqual(["Upload"]);
    expect(buttonNames("charlie")).toEqual(["Retry"]);
    expect(buttonNames("delta")).toEqual(["Remove"]);
    expect(buttonNames("echo")).toEqual([]);

    const drive = within(rowFor("alpha")).getByRole("link", {
      name: /open in drive/i,
    });
    expect(drive).toHaveAttribute("href", "https://drive.example/alpha");
    expect(
      within(rowFor("bravo")).queryByRole("link", { name: /drive/i }),
    ).toBeNull();
  });

  it("hides Remove and disables upload/retry while the run is running", () => {
    renderPanel({ isRunning: true });

    expect(screen.queryByRole("button", { name: /remove/i })).toBeNull();
    expect(
      within(rowFor("bravo")).getByRole("button", { name: /upload/i }),
    ).toBeDisabled();
    expect(
      within(rowFor("charlie")).getByRole("button", { name: /retry/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Upload all pending" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Retry all failed" }),
    ).toBeDisabled();
  });

  it("disables bulk buttons when nothing applies", () => {
    renderPanel({ items: [completedUploaded, pending] });

    expect(
      screen.getByRole("button", { name: "Upload all pending" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Retry all failed" }),
    ).toBeDisabled();
  });

  it("renders only one page of a large list and pages through it", async () => {
    const items = Array.from({ length: 300 }, (_, index) =>
      item(index + 1, { name: `row-${index + 1}` }),
    );
    renderPanel({ items });
    const user = userEvent.setup();

    // One header row plus a single page of body rows, not all 300.
    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("row-1")).toBeInTheDocument();
    expect(screen.queryByText("row-51")).toBeNull();
    expect(screen.getByText(/page 1 of 6/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /next/i }));

    expect(screen.getAllByRole("row")).toHaveLength(51);
    expect(screen.getByText("row-51")).toBeInTheDocument();
    expect(screen.queryByText("row-1")).toBeNull();
    expect(screen.getByText(/page 2 of 6/i)).toBeInTheDocument();
  });

  it("hides pagination when everything fits on one page", () => {
    renderPanel();

    expect(screen.queryByRole("button", { name: /next/i })).toBeNull();
  });

  it("calls upload for the item when Upload is clicked", async () => {
    const { calls } = renderPanel();

    await userEvent.click(
      within(rowFor("bravo")).getByRole("button", { name: /upload/i }),
    );

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: `/api/runs/${RUN_ID}/items/2/upload`,
      }),
    );
  });

  it("calls retry for the item when Retry is clicked", async () => {
    const { calls } = renderPanel();

    await userEvent.click(
      within(rowFor("charlie")).getByRole("button", { name: /retry/i }),
    );

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: `/api/runs/${RUN_ID}/items/3/retry`,
      }),
    );
  });

  it("calls remove for the item when Remove is clicked", async () => {
    const { calls } = renderPanel();

    await userEvent.click(
      within(rowFor("delta")).getByRole("button", { name: /remove/i }),
    );

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "DELETE",
        path: `/api/runs/${RUN_ID}/items/4`,
      }),
    );
  });

  it("calls the bulk endpoints", async () => {
    const { calls } = renderPanel();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Upload all pending" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: `/api/runs/${RUN_ID}/upload-pending`,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Retry all failed" }));
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: "POST",
        path: `/api/runs/${RUN_ID}/retry`,
      }),
    );
  });

  it("surfaces a rejected action's message inline", async () => {
    renderPanel({ conflict: "Drive is not connected" });

    await userEvent.click(
      within(rowFor("bravo")).getByRole("button", { name: /upload/i }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Drive is not connected",
    );
  });
});
