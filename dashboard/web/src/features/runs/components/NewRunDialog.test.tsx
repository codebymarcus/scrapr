import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { runKeys } from "../hooks/runs-keys";
import { makeProject } from "@/test/fixtures";
import { makeRun } from "../test/fixtures";
import { NewRunDialog } from "./NewRunDialog";

type Call = { path: string; method: string; body?: unknown };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const projects = [
  makeProject({
    id: 1,
    name: "Alpha",
    recipe: { name: "alpha", contentType: "text" },
  }),
  makeProject({
    id: 2,
    name: "Beta",
    recipe: { name: "beta", contentType: "text" },
  }),
  makeProject({
    id: 3,
    name: "Gallery",
    recipe: {
      name: "gallery",
      contentType: "image",
      output: {
        drive: true,
        driveFolder: "folder-from-recipe",
        driveSubfolder: "sub-from-recipe",
      },
    },
  }),
  makeProject({
    id: 4,
    name: "Plain images",
    recipe: { name: "plain", contentType: "image" },
  }),
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

function setup(
  handlers: Record<string, (call: Call) => Response> = {},
) {
  const calls: Call[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    const call: Call = {
      path,
      method,
      body: readBody(init),
    };
    calls.push(call);
    const handler = handlers[`${method} ${path}`];
    if (handler) return handler(call);
    if (method === "GET" && path === "/api/projects") {
      return json({ projects });
    }
    if (method === "POST" && path === "/api/runs") {
      return json({ run: makeRun({ id: 9, project_id: 2 }) }, 201);
    }
    return json({ error: "not found" }, 404);
  };
  const client = createApiClient({ baseUrl: "http://test.local", fetchFn });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <NewRunDialog client={client} onClose={onClose} />
    </QueryClientProvider>,
  );
  const writes = () => calls.filter((call) => call.method === "POST");
  return { calls, writes, invalidate, onClose };
}

async function pickProject(name: string) {
  await screen.findByRole("option", { name });
  await userEvent.selectOptions(screen.getByLabelText("Project"), name);
}

describe("NewRunDialog", () => {
  it("is an accessible dialog that closes on Escape", async () => {
    const { onClose } = setup();

    const dialog = screen.getByRole("dialog", { name: "New run" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a run for the chosen project, refreshes the list and closes", async () => {
    const { writes, invalidate, onClose } = setup();

    await pickProject("Beta");
    await userEvent.type(screen.getByLabelText(/Label/), "Weekend batch");
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes()).toEqual([
      {
        path: "/api/runs",
        method: "POST",
        body: { projectId: 2, label: "Weekend batch" },
      },
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.lists() });
  });

  it("enqueues the pasted urls into the new run", async () => {
    const { writes, onClose } = setup({
      "POST /api/runs/9/items": () => json({ added: 2 }),
    });

    await pickProject("Alpha");
    await userEvent.type(
      screen.getByLabelText(/URLs/),
      "https://a.test/1{Enter}  http://b.test/2  {Enter}",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes().map((call) => [call.path, call.body])).toEqual([
      ["/api/runs", { projectId: 1 }],
      [
        "/api/runs/9/items",
        { urls: ["https://a.test/1", "http://b.test/2"] },
      ],
    ]);
  });

  it("imports the chosen sheet into the new run", async () => {
    const { writes, onClose, invalidate } = setup({
      "POST /api/runs/import": () => json({ added: 12 }),
    });

    await pickProject("Alpha");
    await userEvent.upload(
      screen.getByLabelText("Or upload a sheet"),
      sheetFile(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes().map((call) => [call.path, call.body])).toEqual([
      ["/api/runs", { projectId: 1 }],
      ["/api/runs/import", { file: "links.csv", runId: "9" }],
    ]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.lists() });
  });

  it("prefers the sheet over pasted urls and never does both", async () => {
    const { writes, onClose } = setup({
      "POST /api/runs/import": () => json({ added: 1 }),
    });

    await pickProject("Alpha");
    await userEvent.type(screen.getByLabelText(/URLs/), "https://p.test/1");
    await userEvent.upload(
      screen.getByLabelText("Or upload a sheet"),
      sheetFile(),
    );
    expect(screen.getByText(/pasted URLs are ignored/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes().map((call) => call.path)).toEqual([
      "/api/runs",
      "/api/runs/import",
    ]);
  });

  it("keeps the run and retries only the import when the sheet is rejected", async () => {
    let attempt = 0;
    const { writes, onClose } = setup({
      "POST /api/runs/import": () =>
        ++attempt === 1
          ? json({ error: "Unsupported file type" }, 400)
          : json({ added: 3 }),
    });

    await pickProject("Alpha");
    await userEvent.upload(
      screen.getByLabelText("Or upload a sheet"),
      sheetFile(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Run #9 was created");
    expect(alert).toHaveTextContent("Unsupported file type");
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Add items" }));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes().map((call) => call.path)).toEqual([
      "/api/runs",
      "/api/runs/import",
      "/api/runs/import",
    ]);
  });

  it("shows a 409 from the import and keeps the run", async () => {
    const { onClose } = setup({
      "POST /api/runs/import": () =>
        json({ error: "Cannot add items to a running run" }, 409),
    });

    await pickProject("Alpha");
    await userEvent.upload(
      screen.getByLabelText("Or upload a sheet"),
      sheetFile(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot add items to a running run",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("never posts an empty url list", async () => {
    const { writes, onClose } = setup();

    await pickProject("Alpha");
    await userEvent.type(screen.getByLabelText(/URLs/), "   {Enter}  ");
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(writes().map((call) => call.path)).toEqual(["/api/runs"]);
  });

  it("blocks invalid urls client-side, before any request", async () => {
    const { writes, onClose } = setup();

    await pickProject("Alpha");
    await userEvent.type(
      screen.getByLabelText(/URLs/),
      "https://a.test/1{Enter}not-a-url",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Line 2 must start with http:// or https://",
    );
    expect(writes()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("requires a project", async () => {
    const { writes } = setup();

    await screen.findByRole("option", { name: "Alpha" });
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a project",
    );
    expect(writes()).toEqual([]);
  });

  it("shows the server message when enqueueing hits a 409 and keeps the run", async () => {
    const message =
      "Cannot add items to a running run (only queued or stopped runs accept items)";
    const { writes, onClose, invalidate } = setup({
      "POST /api/runs/9/items": () => json({ error: message }, 409),
    });

    await pickProject("Alpha");
    await userEvent.type(screen.getByLabelText(/URLs/), "https://a.test/1");
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(onClose).not.toHaveBeenCalled();
    // The run exists, so the list must show it.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: runKeys.lists() });

    // Retrying must not create a second run.
    await userEvent.click(screen.getByRole("button", { name: "Add URLs" }));
    await vi.waitFor(() =>
      expect(writes().map((call) => call.path)).toEqual([
        "/api/runs",
        "/api/runs/9/items",
        "/api/runs/9/items",
      ]),
    );
  });

  it("shows a server error from creating the run", async () => {
    const { onClose } = setup({
      "POST /api/runs": () => json({ error: "Project not found" }, 404),
    });

    await pickProject("Alpha");
    await userEvent.click(screen.getByRole("button", { name: "Create run" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Project not found",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  describe("Drive overrides", () => {
    it("shows the Drive fields prefilled from an image project's recipe", async () => {
      setup();

      await pickProject("Gallery");

      expect(screen.getByRole("switch", { name: "Upload to Drive" })).toBeChecked();
      expect(screen.getByLabelText("Folder ID")).toHaveValue("folder-from-recipe");
      expect(screen.getByLabelText("Subfolder name")).toHaveValue("sub-from-recipe");
    });

    it("defaults to off and blank for an image recipe without Drive output", async () => {
      setup();

      await pickProject("Plain images");

      expect(
        screen.getByRole("switch", { name: "Upload to Drive" }),
      ).not.toBeChecked();
      expect(screen.getByLabelText("Folder ID")).toHaveValue("");
      expect(screen.getByLabelText("Subfolder name")).toHaveValue("");
    });

    it("shows no Drive fields for a text project", async () => {
      setup();

      await pickProject("Gallery");
      await pickProject("Alpha");

      expect(screen.queryByRole("switch")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Folder ID")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Subfolder name")).not.toBeInTheDocument();
    });

    it("posts the toggle and the folder id the user set", async () => {
      const { writes, onClose } = setup();

      await pickProject("Plain images");
      await userEvent.click(
        screen.getByRole("switch", { name: "Upload to Drive" }),
      );
      await userEvent.type(screen.getByLabelText("Folder ID"), "abc123");
      await userEvent.click(screen.getByRole("button", { name: "Create run" }));

      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(writes()[0]?.body).toEqual({
        projectId: 4,
        // Drive on + a recipe with no package defaults to CBZ (loose can't upload).
        overrides: { drive: true, format: "cbz", driveFolder: "abc123" },
      });
    });

    it("omits blank folder fields so the recipe values are not clobbered", async () => {
      const { writes, onClose } = setup();

      await pickProject("Gallery");
      await userEvent.clear(screen.getByLabelText("Folder ID"));
      await userEvent.clear(screen.getByLabelText("Subfolder name"));
      await userEvent.click(screen.getByRole("button", { name: "Create run" }));

      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      const body = writes()[0]?.body as { overrides: Record<string, unknown> };
      expect(body.overrides).toEqual({ drive: true, format: "cbz" });
      expect(body.overrides).not.toHaveProperty("driveFolder");
      expect(body.overrides).not.toHaveProperty("driveSubfolder");
    });

    it("treats a whitespace-only folder id as blank", async () => {
      const { writes, onClose } = setup();

      await pickProject("Gallery");
      await userEvent.clear(screen.getByLabelText("Folder ID"));
      await userEvent.type(screen.getByLabelText("Folder ID"), "   ");
      await userEvent.click(screen.getByRole("button", { name: "Create run" }));

      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      const body = writes()[0]?.body as { overrides: Record<string, unknown> };
      expect(body.overrides).not.toHaveProperty("driveFolder");
    });

    it("sends no overrides at all for a text project", async () => {
      const { writes, onClose } = setup();

      await pickProject("Gallery");
      await pickProject("Alpha");
      await userEvent.click(screen.getByRole("button", { name: "Create run" }));

      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(writes()[0]?.body).toEqual({ projectId: 1 });
    });

    it("defaults the format picker to the recipe and posts it", async () => {
      const { writes, onClose } = setup();

      await pickProject("Plain images");
      // No package in the recipe and Drive off → loose images.
      expect(screen.getByLabelText("Output format")).toHaveValue("loose");
      await userEvent.click(screen.getByRole("button", { name: "Create run" }));

      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      const body = writes()[0]?.body as { overrides: Record<string, unknown> };
      expect(body.overrides).toMatchObject({ drive: false, format: "loose" });
    });

    it("posts the chosen output format", async () => {
      const { writes, onClose } = setup();

      await pickProject("Plain images");
      await userEvent.selectOptions(screen.getByLabelText("Output format"), "pdf");
      await userEvent.click(screen.getByRole("button", { name: "Create run" }));

      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      const body = writes()[0]?.body as { overrides: Record<string, unknown> };
      expect(body.overrides).toMatchObject({ format: "pdf" });
    });

    it("drops the Loose option and coerces to a package when Drive is on", async () => {
      const { writes, onClose } = setup();

      await pickProject("Plain images");
      await userEvent.selectOptions(screen.getByLabelText("Output format"), "loose");
      await userEvent.click(
        screen.getByRole("switch", { name: "Upload to Drive" }),
      );

      // With Drive on, "Loose images only" is no longer offered.
      expect(
        screen.queryByRole("option", { name: "Loose images only" }),
      ).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole("button", { name: "Create run" }));
      await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
      const body = writes()[0]?.body as { overrides: Record<string, unknown> };
      expect(body.overrides).toMatchObject({ drive: true, format: "cbz" });
    });
  });
});
