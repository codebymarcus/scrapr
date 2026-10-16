import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import type { RunSocket } from "../hooks/use-run-events";
import { makeProject } from "@/test/fixtures";
import { makeFakeClient, makeItem, makeRun } from "../test/fixtures";
import { RunsPage } from "./RunsPage";

// Never connects, so no real WebSocket is opened from jsdom.
const idleSocket = (): RunSocket => ({
  onopen: null,
  onmessage: null,
  onerror: null,
  onclose: null,
  close: () => {},
});

function renderPage(
  client: ReturnType<typeof makeFakeClient>,
  entry: string | { pathname: string; state: unknown } = "/",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <RunsPage client={client} socketFactory={idleSocket} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const running = makeRun({ id: 1, label: "Running run", state: "running" });
const stopped = makeRun({ id: 2, label: "Stopped run", state: "stopped" });
const done = makeRun({
  id: 3,
  label: "Finished run",
  state: "done",
  finished_at: new Date().toISOString(),
});

describe("RunsPage", () => {
  it("groups runs into running, resumable and recent", async () => {
    renderPage(
      makeFakeClient({
        "/api/runs": { runs: [running, stopped, done] },
        "/api/runs/1": {
          run: running,
          items: [
            makeItem({ id: 1, run_id: 1, saved: 5, total: 5 }),
            makeItem({ id: 2, run_id: 1 }),
          ],
        },
        "/api/runs/2": { run: stopped, items: [] },
      }),
    );

    const runningGroup = await screen.findByRole("region", {
      name: "Running",
    });
    expect(
      within(runningGroup).getByRole("heading", { name: "Running run" }),
    ).toBeInTheDocument();
    expect(
      within(runningGroup).getByText("Running", { selector: "span" }),
    ).toBeInTheDocument();
    expect(
      await within(runningGroup).findByRole("progressbar", { name: "1 of 2" }),
    ).toBeInTheDocument();

    const resumable = screen.getByRole("region", {
      name: "Stopped — resumable",
    });
    expect(
      within(resumable).getByRole("heading", { name: "Stopped run" }),
    ).toBeInTheDocument();

    const recent = screen.getByRole("region", { name: "Recent" });
    expect(
      within(recent).getByRole("heading", { name: "Finished run" }),
    ).toBeInTheDocument();
    expect(within(recent).getByText("Done")).toBeInTheDocument();
  });

  it("shows the stat strip with derived figures", async () => {
    renderPage(
      makeFakeClient({
        "/api/runs": { runs: [running, stopped, done] },
        "/api/runs/1": {
          run: running,
          items: [
            makeItem({ id: 1, run_id: 1, saved: 5, total: 5 }),
            makeItem({ id: 2, run_id: 1 }),
            makeItem({ id: 3, run_id: 1 }),
          ],
        },
        "/api/runs/2": { run: stopped, items: [] },
      }),
    );

    const strip = await screen.findByRole("group", { name: "Run stats" });
    expect(within(strip).getByText("Running").nextSibling).toHaveTextContent(
      "1",
    );
    expect(within(strip).getByText("Done today").nextSibling).toHaveTextContent(
      "1",
    );
    expect(
      await within(strip).findByText("2", { selector: "dd" }),
    ).toBeInTheDocument();
  });

  it("shows unavailable stats as a dash instead of zero", async () => {
    renderPage(makeFakeClient({ "/api/runs": { runs: [done] } }));

    const strip = await screen.findByRole("group", { name: "Run stats" });
    expect(
      within(strip).getByText("Failing hosts").nextSibling,
    ).toHaveTextContent("—");
  });

  it("keeps an action's 409 message after the refetch regroups the card", async () => {
    // The run is stopped at first; the start attempt loses a race (409) and
    // the refetched list shows it already running, so it changes group.
    let serverState: "stopped" | "running" = "stopped";
    const respond = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const fetchFn: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const current = makeRun({ id: 2, label: "Racy run", state: serverState });
      if (path === "/api/runs/2/start" && init?.method === "POST") {
        serverState = "running";
        return respond({ error: "Cannot start a running run" }, 409);
      }
      if (path === "/api/runs/2") return respond({ run: current, items: [] });
      if (path === "/api/runs") return respond({ runs: [current] });
      return respond({ error: "not found" }, 404);
    };
    renderPage(createApiClient({ baseUrl: "http://test.local", fetchFn }));

    await userEvent.click(
      await screen.findByRole("button", { name: "Resume Racy run" }),
    );

    const runningGroup = await screen.findByRole("region", {
      name: "Running",
    });
    expect(
      screen.queryByRole("region", { name: "Stopped — resumable" }),
    ).not.toBeInTheDocument();
    expect(await within(runningGroup).findByRole("alert")).toHaveTextContent(
      "Cannot start a running run",
    );
  });

  it("hides empty groups", async () => {
    renderPage(makeFakeClient({ "/api/runs": { runs: [done] } }));

    await screen.findByRole("region", { name: "Recent" });
    expect(
      screen.queryByRole("region", { name: "Running" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Stopped — resumable" }),
    ).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no runs", async () => {
    renderPage(makeFakeClient({ "/api/runs": { runs: [] } }));

    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "+ New run" }),
    ).toBeInTheDocument();
  });

  it("shows an error state with retry when loading fails", async () => {
    renderPage(
      makeFakeClient({
        "/api/runs": () => new Response("nope", { status: 400 }),
      }),
    );

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("renders the header actions", async () => {
    renderPage(makeFakeClient({ "/api/runs": { runs: [] } }));

    expect(
      await screen.findByRole("button", { name: "+ New run" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Import list" }),
    ).toBeInTheDocument();
  });

  it("opens the new-run and import dialogs from the header", async () => {
    renderPage(
      makeFakeClient({
        "/api/runs": { runs: [] },
        "/api/projects": { projects: [makeProject({ id: 1 })] },
      }),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "+ New run" }),
    );
    expect(screen.getByRole("dialog", { name: "New run" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Import list" }));
    expect(
      screen.getByRole("dialog", { name: "Import list" }),
    ).toBeInTheDocument();
  });

  it("tags each run card with its project's content type", async () => {
    renderPage(
      makeFakeClient({
        "/api/runs": {
          runs: [
            makeRun({ id: 1, label: "Pictures", project_id: 1, state: "done" }),
            makeRun({ id: 2, label: "Articles", project_id: 2, state: "done" }),
            makeRun({ id: 3, label: "Orphan", project_id: 99, state: "done" }),
          ],
        },
        "/api/projects": {
          projects: [
            makeProject({ id: 1, recipe: { name: "a", contentType: "image" } }),
            makeProject({ id: 2, recipe: { name: "b", contentType: "text" } }),
          ],
        },
      }),
    );

    const pictures = await screen.findByRole("heading", { name: "Pictures" });
    expect(
      await within(pictures.closest("article")!).findByText("image"),
    ).toBeInTheDocument();
    const articles = screen.getByRole("heading", { name: "Articles" });
    expect(
      within(articles.closest("article")!).getByText("text"),
    ).toBeInTheDocument();
    const orphan = screen.getByRole("heading", { name: "Orphan" });
    expect(
      within(orphan.closest("article")!).queryByText(/^(image|text)$/),
    ).not.toBeInTheDocument();
  });

  it("opens the new-run dialog preselecting the project from router state", async () => {
    renderPage(
      makeFakeClient({
        "/api/runs": { runs: [] },
        "/api/projects": {
          projects: [
            makeProject({ id: 1, name: "Alpha" }),
            makeProject({ id: 2, name: "Beta" }),
          ],
        },
      }),
      { pathname: "/", state: { newRunProjectId: 2 } },
    );

    const dialog = await screen.findByRole("dialog", { name: "New run" });
    expect(await within(dialog).findByLabelText("Project")).toHaveValue("2");
  });
});
