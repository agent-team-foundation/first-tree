import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FirstTreeHubSDK } from "../sdk.js";

const SERVER_URL = "https://first-tree.example";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FirstTreeHubSDK.getMemberContextTreeSetting", () => {
  it("reads exactly the explicit Team route once without /me or Agent authority headers", async () => {
    const binding = { repo: "https://github.com/acme/context-tree.git", branch: "main" };
    const fetchMock = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(JSON.stringify(binding), { status: 200, headers: { "content-type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const getAccessToken = vi.fn(async () => "member-access-token");
    const sdk = new FirstTreeHubSDK({ serverUrl: SERVER_URL, getAccessToken });

    await expect(sdk.getMemberContextTreeSetting("team /?#", { retry: false })).resolves.toEqual(binding);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `${SERVER_URL}/api/v1/orgs/team%20%2F%3F%23/settings/context_tree`,
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toEqual(expect.objectContaining({ Authorization: "Bearer member-access-token" }));
    expect(init?.method).toBeUndefined();
    expect(init?.headers).not.toHaveProperty(AGENT_SELECTOR_HEADER);
    expect(init?.headers).not.toHaveProperty(AGENT_RUNTIME_SESSION_HEADER);
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it("does not repeat the Server authority check when strict activation disables retries", async () => {
    const fetchMock = vi
      .fn(
        async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
          new Response(JSON.stringify({ error: "transient" }), {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "transient" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ repo: "https://github.com/acme/tree.git", branch: "main" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({ serverUrl: SERVER_URL, getAccessToken: async () => "member-access-token" });

    await expect(sdk.getMemberContextTreeSetting("team-a", { retry: false })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
