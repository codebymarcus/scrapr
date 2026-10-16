import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { Sidebar } from "./Sidebar";

function setup(respond: () => Response | Promise<Response>) {
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: async () => respond(),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Sidebar theme="dark" onToggleTheme={() => {}} client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

describe("Sidebar engine indicator", () => {
  it("shows a neutral checking state before health resolves", () => {
    setup(() => new Promise<Response>(() => {}));

    expect(screen.getByRole("status")).toHaveTextContent("Checking engine");
  });

  it("shows connected when /api/health is ok", async () => {
    setup(() => json({ ok: true }));

    expect(await screen.findByText("Engine connected")).toBeInTheDocument();
  });

  it("shows disconnected when health reports not ok", async () => {
    setup(() => json({ ok: false }));

    expect(await screen.findByText("Engine disconnected")).toBeInTheDocument();
  });

  it("shows disconnected when the health request fails", async () => {
    setup(() => json({ error: "down" }, 500));

    expect(await screen.findByText("Engine disconnected")).toBeInTheDocument();
  });
});
