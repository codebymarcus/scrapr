import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@/lib/http/api-client";
import {
  connectDrive,
  disconnectAccount,
  fetchDriveAccounts,
  renameAccount,
} from "./drive-api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function setup(body: unknown = {}) {
  const fetchFn = vi.fn(async () => jsonResponse(body));
  const client = createApiClient({
    baseUrl: "http://api.test",
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  const lastCall = () =>
    fetchFn.mock.calls[0] as unknown as [string, RequestInit];
  return { client, lastCall };
}

describe("drive-api accounts", () => {
  it("fetchDriveAccounts GETs and parses the accounts list", async () => {
    const { client, lastCall } = setup({
      configured: true,
      accounts: [{ id: "a1", label: null, email: null, connected: true }],
    });
    const data = await fetchDriveAccounts(undefined, client);
    expect(data.accounts).toHaveLength(1);
    const [url, init] = lastCall();
    expect(url).toBe("http://api.test/api/drive/accounts");
    expect(init.method).toBe("GET");
  });

  it("connectDrive passes accountId as a query param", async () => {
    const { client, lastCall } = setup({ url: "https://g.example/auth" });
    const data = await connectDrive(client, "acc_1");
    expect(data.url).toBe("https://g.example/auth");
    expect(lastCall()[0]).toBe(
      "http://api.test/api/drive/connect?accountId=acc_1",
    );
  });

  it("connectDrive without an accountId has no query string", async () => {
    const { client, lastCall } = setup({ url: "https://g.example/auth" });
    await connectDrive(client);
    expect(lastCall()[0]).toBe("http://api.test/api/drive/connect");
  });

  it("disconnectAccount POSTs to the account disconnect path", async () => {
    const { client, lastCall } = setup({ disconnected: true });
    await disconnectAccount("x", client);
    const [url, init] = lastCall();
    expect(url).toBe("http://api.test/api/drive/accounts/x/disconnect");
    expect(init.method).toBe("POST");
  });

  it("disconnectAccount encodes the id in the path", async () => {
    const { client, lastCall } = setup({ disconnected: true });
    await disconnectAccount("a/b", client);
    expect(lastCall()[0]).toBe(
      "http://api.test/api/drive/accounts/a%2Fb/disconnect",
    );
  });

  it("renameAccount PATCHes the label", async () => {
    const { client, lastCall } = setup({ id: "x", label: "New" });
    await renameAccount("x", "New", client);
    const [url, init] = lastCall();
    expect(url).toBe("http://api.test/api/drive/accounts/x");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ label: "New" });
  });
});
