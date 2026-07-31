import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK } from "../sdk.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubFeed() {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  globalThis.fetch = fetchMock;
  return fetchMock;
}

function agentSdk() {
  return new FirstTreeHubSDK({
    serverUrl: "https://cloud.example",
    getAccessToken: () => "member-jwt",
    agentId: "agent/auditor",
    runtimeSessionToken: "runtime-proof",
  });
}

function requestedUrl(fetchMock: ReturnType<typeof stubFeed>): URL {
  const [input] = fetchMock.mock.calls[0] ?? [];
  return new URL(typeof input === "string" ? input : String(input));
}

describe("FirstTreeHubSDK.listAgentContextTreeIo", () => {
  it("serializes every filter onto the request URL", async () => {
    const fetchMock = stubFeed();
    await agentSdk().listAgentContextTreeIo({
      chatId: "chat-1",
      action: "read",
      since: "2026-07-01T00:00:00Z",
      until: "2026-07-31T00:00:00Z",
      limit: 25,
      cursor: "cursor-1",
    });

    const url = requestedUrl(fetchMock);
    expect(url.pathname).toBe("/api/v1/agent/context-tree/io");
    expect(url.searchParams.get("chatId")).toBe("chat-1");
    expect(url.searchParams.get("action")).toBe("read");
    expect(url.searchParams.get("since")).toBe("2026-07-01T00:00:00Z");
    expect(url.searchParams.get("until")).toBe("2026-07-31T00:00:00Z");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("cursor-1");
  });

  it("sends the agent selector and runtime-session proof the Class D route requires", async () => {
    const fetchMock = stubFeed();
    await agentSdk().listAgentContextTreeIo({ limit: 10 });

    const init = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(init?.headers);
    expect(headers.get("x-agent-id")).toBe("agent/auditor");
    expect(headers.get("x-agent-runtime-session")).toBe("runtime-proof");
    expect(headers.get("authorization")).toBe("Bearer member-jwt");
  });

  it("accepts a filter without an explicit limit and still defers to the server default", async () => {
    const fetchMock = stubFeed();
    // Regression: the options type must be the schema INPUT type. With the
    // parsed output type, `limit` is required by its `.default(50)` and this
    // call would not compile even though the server supplies the default.
    await agentSdk().listAgentContextTreeIo({ action: "read" });

    const url = requestedUrl(fetchMock);
    expect(url.searchParams.get("action")).toBe("read");
    expect(url.searchParams.has("limit")).toBe(false);
  });

  it("omits the query string entirely when no filter is supplied", async () => {
    const fetchMock = stubFeed();
    await agentSdk().listAgentContextTreeIo();

    const url = requestedUrl(fetchMock);
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/api/v1/agent/context-tree/io");
  });
});
