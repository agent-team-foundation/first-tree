import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../sdk.js";

const SERVER_URL = "https://first-tree.example";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FirstTreeHubSDK.preflightMemberContextTreeSeed", () => {
  it("uses only the explicit Team member route and returns Server current binding state", async () => {
    const authority = {
      organizationId: "team /?#",
      state: {
        status: "bound",
        binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
      },
      gitlabConnection: null,
    };
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(authority));
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: async () => "member-access-token",
    });

    await expect(sdk.preflightMemberContextTreeSeed("team /?#", {}, { retry: false })).resolves.toEqual(authority);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${SERVER_URL}/api/v1/orgs/team%20%2F%3F%23/context-tree/seed-preflight`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({});
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer member-access-token");
    expect(headers.has(AGENT_SELECTOR_HEADER)).toBe(false);
    expect(headers.has(AGENT_RUNTIME_SESSION_HEADER)).toBe(false);
  });

  it("rejects caller-selected role or binding before transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: async () => "member-access-token",
    });

    await expect(
      sdk.preflightMemberContextTreeSeed("team-a", { role: "admin" } as never, { retry: false }),
    ).rejects.toThrow();
    await expect(
      sdk.preflightMemberContextTreeSeed("team-a", { binding: null } as never, { retry: false }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not hide a transport failure behind a retry when retries are disabled", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, 503))
      .mockResolvedValueOnce(jsonResponse({ organizationId: "team-a", state: { status: "unbound", branch: "main" } }));
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: async () => "member-access-token",
    });

    await expect(sdk.preflightMemberContextTreeSeed("team-a", {}, { retry: false })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
