import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import type { RunSocket } from "../hooks/use-run-events";
import { makeItem, makeRun } from "../test/fixtures";
import { RunCard } from "./RunCard";

type Handler = (path: string) => Response;

function makeClient(handler: Handler = () => new Response("{}")) {
  const fetchFn = vi.fn(async (input: RequestInfo | URL) =>
    handler(new URL(String(input)).pathname),
  );
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { client, fetchFn };
}

// A socket that never connects: the card should still render and poll.
const idleSocket = (): RunSocket => ({
  onopen: null,
  onmessage: null,
  onerror: null,
  onclose: null,
  close: () => {},
});

function renderCard(
  props: Omit<Parameters<typeof RunCard>[0], "client" | "socketFactory"> & {
    client?: ReturnType<typeof makeClient>["client"];
  },
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const client = props.client ?? makeClient().client;
  return render(
    <QueryClientProvider client={queryClient}>
      <RunCard {...props} client={client} socketFactory={idleSocket} />
    </QueryClientProvider>,
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.useRealTimers();
});

describe("RunCard", () => {
  it("renders the name, state badge and content-type tag", () => {
    renderCard({
      run: makeRun({ id: 1, label: "Berserk vol 1", state: "running" }),
      contentType: "image",
      progress: { done: 3, total: 12 },
    });

    expect(
      screen.getByRole("heading", { name: "Berserk vol 1" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("image")).toBeInTheDocument();
  });

  it("hides the content-type tag when the type is unknown", () => {
    renderCard({ run: makeRun({ id: 1, state: "done", project_id: 9 }) });
    expect(screen.queryByText(/project/i)).not.toBeInTheDocument();
  });

  it("shows a progressbar with counts for a running run", () => {
    renderCard({
      run: makeRun({ id: 1, state: "running" }),
      progress: { done: 3, total: 12 },
    });

    const bar = screen.getByRole("progressbar", { name: "3 of 12" });
    expect(bar).toHaveAttribute("aria-valuenow", "3");
    expect(bar).toHaveAttribute("aria-valuemax", "12");
    expect(screen.getByText("3 of 12 items")).toBeInTheDocument();
  });

  it("falls back to a progressbar without counts when progress is unknown", () => {
    renderCard({ run: makeRun({ id: 1, state: "running" }) });
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("omits the progressbar for a finished run without progress", () => {
    renderCard({ run: makeRun({ id: 1, state: "done" }) });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("falls back to a run number when there is no label", () => {
    renderCard({ run: makeRun({ id: 7, label: null, state: "done" }) });
    expect(screen.getByRole("heading", { name: "Run #7" })).toBeInTheDocument();
  });

  it("offers Resume on a stopped run and posts to the start endpoint", async () => {
    const { client, fetchFn } = makeClient(() => json({ run: {} }));
    renderCard({ run: makeRun({ id: 2, state: "stopped" }), client });

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        "http://test.local/api/runs/2/start",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers Start on a queued run", async () => {
    const { client, fetchFn } = makeClient(() => json({ run: {} }));
    renderCard({ run: makeRun({ id: 3, state: "queued" }), client });

    await userEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        "http://test.local/api/runs/3/start",
        expect.anything(),
      ),
    );
  });

  it("offers only Stop on a running run (no pause endpoint exists)", async () => {
    const { client, fetchFn } = makeClient((path) =>
      path.endsWith("/stop") ? json({ stopped: true }) : json({}),
    );
    renderCard({ run: makeRun({ id: 4, state: "running" }), client });

    expect(
      screen.queryByRole("button", { name: /pause/i }),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() =>
      expect(fetchFn).toHaveBeenCalledWith(
        "http://test.local/api/runs/4/stop",
        expect.anything(),
      ),
    );
  });

  it("offers no actions on finished runs", () => {
    renderCard({ run: makeRun({ id: 5, state: "done" }) });
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the server's message inline when an action returns 409", async () => {
    const { client } = makeClient(() =>
      json({ error: "Cannot start a running run" }, 409),
    );
    renderCard({ run: makeRun({ id: 2, state: "stopped" }), client });

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot start a running run",
    );
    expect(screen.getByRole("button", { name: "Resume" })).toBeEnabled();
  });

  it("shows other failures inline too", async () => {
    const { client } = makeClient(() => json({ error: "Run not found" }, 404));
    renderCard({ run: makeRun({ id: 2, state: "stopped" }), client });

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Run not found");
  });

  it("polls the run detail while the live socket is down", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const run = makeRun({ id: 1, state: "running" });
    const { client, fetchFn } = makeClient(() =>
      json({ run, items: [makeItem({ id: 1, run_id: 1 })] }),
    );
    renderCard({ run, client });

    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });

    expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
