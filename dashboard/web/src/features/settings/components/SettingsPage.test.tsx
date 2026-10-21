import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import { usePreferencesStore } from "@/stores/use-preferences-store";
import { SettingsPage } from "./SettingsPage";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const work = {
  id: "acc-work",
  label: "Work",
  email: "work@example.com",
  connected: true,
};

const personal = {
  id: "acc-personal",
  label: null,
  email: "me@example.com",
  connected: false,
};

const twoAccounts = { configured: true, accounts: [work, personal] };
const noAccounts = { configured: true, accounts: [] };
const notConfigured = { configured: false, accounts: [] };

type Call = { method: string; path: string; search: string; body: string };

function setup(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = createApiClient({
    baseUrl: "http://test.local",
    fetchFn: async (input, init) => {
      const url = new URL(String(input));
      const call = {
        method: init?.method ?? "GET",
        path: url.pathname,
        search: url.search,
        body: typeof init?.body === "string" ? init.body : "",
      };
      calls.push(call);
      return respond(call);
    },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsPage client={client} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls };
}

/** Account cards only (the Appearance toggles are list items too). */
const accountItems = () =>
  within(screen.getByRole("region", { name: "Google Drive" })).queryAllByRole(
    "listitem",
  );

beforeEach(() => {
  usePreferencesStore.setState({ theme: "dark", grain: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsPage", () => {
  it("renders a card per account with label and email", async () => {
    setup(() => json(twoAccounts));

    await screen.findByRole("heading", { name: "Work" });
    const items = accountItems();
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText("Work")).toBeInTheDocument();
    expect(within(items[0]).getByText("work@example.com")).toBeInTheDocument();
    expect(within(items[0]).getByText("Connected")).toBeInTheDocument();
    // Unlabelled accounts fall back to their email.
    expect(
      within(items[1]).getByRole("heading", { name: "me@example.com" }),
    ).toBeInTheDocument();
    expect(within(items[1]).getByText("Needs reconnect")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect another Drive" }),
    ).toBeInTheDocument();
  });

  it("offers to connect a first Drive when there are no accounts", async () => {
    setup(() => json(noAccounts));

    expect(
      await screen.findByRole("button", { name: "Connect Google Drive" }),
    ).toBeInTheDocument();
    expect(accountItems()).toHaveLength(0);
  });

  it("shows a not-configured message and no account actions", async () => {
    setup(() => json(notConfigured));

    expect(await screen.findByText(/isn.t configured/i)).toBeInTheDocument();
    expect(accountItems()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /connect/i })).toBeNull();
  });

  it("disconnects one account by id and refreshes the list", async () => {
    let accounts = [work, personal];
    const { calls } = setup(({ method, path }) => {
      if (method === "POST" && path === "/api/drive/accounts/acc-work/disconnect") {
        accounts = [personal];
        return json({ disconnected: true });
      }
      return json({ configured: true, accounts });
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Disconnect Work" }),
    );

    await waitFor(() => expect(accountItems()).toHaveLength(1));
    expect(calls).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/api/drive/accounts/acc-work/disconnect",
      }),
    );
  });

  it("renames an account inline and refreshes the list", async () => {
    let accounts = [work];
    const { calls } = setup(({ method, path, body }) => {
      if (method === "PATCH" && path === "/api/drive/accounts/acc-work") {
        accounts = [{ ...work, label: JSON.parse(body).label }];
        return json({ renamed: true });
      }
      return json({ configured: true, accounts });
    });

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename Work" }),
    );
    const input = screen.getByRole("textbox", { name: "Account name" });
    expect(input).toHaveValue("Work");
    await userEvent.clear(input);
    await userEvent.type(input, "Client Drive");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByRole("heading", { name: "Client Drive" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/drive/accounts/acc-work");
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ label: "Client Drive" });
  });

  it("cancels a rename without calling the server", async () => {
    const { calls } = setup(() => json({ configured: true, accounts: [work] }));

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename Work" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("does not allow saving an empty name", async () => {
    setup(() => json({ configured: true, accounts: [work] }));

    await userEvent.click(
      await screen.findByRole("button", { name: "Rename Work" }),
    );
    await userEvent.clear(screen.getByRole("textbox", { name: "Account name" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("Connect another Drive starts a new connection and navigates", async () => {
    const location = { href: "http://localhost/settings" };
    vi.stubGlobal("location", location);
    const { calls } = setup(({ path }) =>
      path === "/api/drive/connect"
        ? json({ url: "https://accounts.google.com/o/oauth2/auth?x=1" })
        : json(twoAccounts),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Connect another Drive" }),
    );

    await waitFor(() =>
      expect(location.href).toBe("https://accounts.google.com/o/oauth2/auth?x=1"),
    );
    const connect = calls.find((c) => c.path === "/api/drive/connect");
    expect(connect?.method).toBe("GET");
    expect(connect?.search).toBe("");
  });

  it("Reconnect on a card re-authorizes that account", async () => {
    const location = { href: "http://localhost/settings" };
    vi.stubGlobal("location", location);
    const { calls } = setup(({ path }) =>
      path === "/api/drive/connect"
        ? json({ url: "https://accounts.google.com/o/oauth2/auth?y=2" })
        : json(twoAccounts),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Reconnect me@example.com" }),
    );

    await waitFor(() =>
      expect(location.href).toBe("https://accounts.google.com/o/oauth2/auth?y=2"),
    );
    expect(calls).toContainEqual(
      expect.objectContaining({
        path: "/api/drive/connect",
        search: "?accountId=acc-personal",
      }),
    );
  });

  it("shows the error when starting the connect flow fails", async () => {
    setup(({ path }) =>
      path === "/api/drive/connect"
        ? json({ error: "Drive OAuth is not configured" }, 409)
        : json(twoAccounts),
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Connect another Drive" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Drive OAuth is not configured",
    );
  });

  it("shows an error state with retry when the accounts fail to load", async () => {
    setup(() => json({ error: "boom" }, 400));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load Drive accounts.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Appearance still works without Drive.
    expect(screen.getByRole("switch", { name: "Film grain" })).toBeInTheDocument();
  });

  it("flips the grain preference and the data-grain attribute", async () => {
    setup(() => json(twoAccounts));

    const grain = await screen.findByRole("switch", { name: "Film grain" });
    expect(grain).toBeChecked();

    await userEvent.click(grain);

    expect(usePreferencesStore.getState().grain).toBe(false);
    expect(grain).not.toBeChecked();
    expect(document.documentElement).not.toHaveAttribute("data-grain");

    await userEvent.click(grain);

    expect(usePreferencesStore.getState().grain).toBe(true);
    expect(document.documentElement).toHaveAttribute("data-grain");
  });

  it("flips the theme preference", async () => {
    setup(() => json(twoAccounts));

    const theme = await screen.findByRole("switch", { name: "Dark theme" });
    expect(theme).toBeChecked();

    await userEvent.click(theme);

    expect(usePreferencesStore.getState().theme).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
