import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { makeFakeClient, makeItem, makeRun } from "../test/fixtures";
import { RunsPage } from "./RunsPage";

function renderPage(client: ReturnType<typeof makeFakeClient>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunsPage client={client} />
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
});
