import { AGENT_SELECTOR_HEADER, type Attention } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK, SdkError } from "../sdk.js";

const SERVER_URL = "https://hub.example/";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function makeFetchMock(responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeSdk(): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl: SERVER_URL,
    agentId: "agent-1",
    userAgent: "first-tree-test",
    getAccessToken: () => "access-token",
  });
}

async function flush<T>(promise: Promise<T>, maxFlushes = 50): Promise<T> {
  let settled = false;
  let result: T | undefined;
  let error: unknown;
  promise.then(
    (value) => {
      result = value;
      settled = true;
    },
    (err) => {
      error = err;
      settled = true;
    },
  );
  for (let i = 0; i < maxFlushes && !settled; i++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1000);
  }
  if (!settled) throw new Error("flush did not settle within maxFlushes");
  if (error !== undefined) throw error;
  return result as T;
}

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    id: "att-1",
    originAgentId: "agent-1",
    originChatId: "chat-1",
    targetHumanId: "human-1",
    subject: "Need review",
    body: "Please review",
    requiresResponse: true,
    state: "open",
    response: null,
    respondedBy: null,
    respondedAt: null,
    cancelled: false,
    cancelledReason: null,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

describe("FirstTreeHubSDK public surface", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes serverUrl and exposes the scoped agent id", () => {
    const sdk = makeSdk();

    expect(sdk.serverUrl).toBe("https://hub.example");
    expect(sdk.agentId).toBe("agent-1");
  });

  it("register maps agent identity defaults", async () => {
    makeFetchMock([
      jsonResponse({
        uuid: "agent-1",
        inboxId: "inbox-1",
        status: "online",
        displayName: "Agent One",
        type: "agent",
        visibility: "organization",
      }),
    ]);

    await expect(makeSdk().register()).resolves.toEqual({
      agentId: "agent-1",
      inboxId: "inbox-1",
      status: "online",
      displayName: "Agent One",
      type: "agent",
      visibility: "organization",
      delegateMention: null,
      metadata: {},
    });
  });

  it("sends auth, agent selector, user agent, and JSON content headers", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ id: "m1", chatId: "chat-1", content: "hi" })]);

    await makeSdk().sendMessage("chat-1", { source: "api", format: "text", content: "hi" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/agent/chats/chat-1/messages",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ source: "api", format: "text", content: "hi" }),
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          [AGENT_SELECTOR_HEADER]: "agent-1",
          "User-Agent": "first-tree-test",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("covers member and agent JSON endpoints", async () => {
    const responses = [
      jsonResponse({ repo: "https://example.com/tree.git", branch: "main" }),
      jsonResponse({ agentId: "agent-1", version: 3, payload: { gitRepos: [] } }),
      jsonResponse([{ agentId: "agent-1", clientId: "client-1", runtimeProvider: "codex", status: "suspended" }]),
      jsonResponse({ items: [{ id: "chat-1" }], nextCursor: "next" }),
      jsonResponse({ id: "chat-1", topic: "Build" }),
      jsonResponse({ items: [{ id: "m1" }], nextCursor: null }),
      jsonResponse([{ agentId: "agent-1", name: "agent", displayName: "Agent" }]),
      jsonResponse([{ agentId: "agent-2", name: "peer", displayName: "Peer" }]),
      jsonResponse({ repo: null, branch: null }),
    ];
    const fetchMock = makeFetchMock(responses);
    const sdk = makeSdk();

    await expect(sdk.getContextTreeConfig()).resolves.toEqual({ repo: "https://example.com/tree.git", branch: "main" });
    await expect(sdk.fetchAgentConfig()).resolves.toMatchObject({ agentId: "agent-1", version: 3 });
    await expect(sdk.listMyAgents()).resolves.toEqual([
      { agentId: "agent-1", clientId: "client-1", runtimeProvider: "codex", status: "suspended" },
    ]);
    await expect(sdk.listChats({ limit: 20, cursor: "abc" })).resolves.toMatchObject({ nextCursor: "next" });
    await expect(sdk.getChatDetail("chat-1")).resolves.toMatchObject({ id: "chat-1" });
    await expect(sdk.listMessages("chat-1", { limit: 10, cursor: "m0" })).resolves.toMatchObject({ nextCursor: null });
    await expect(sdk.listChatParticipants("chat-1")).resolves.toHaveLength(1);
    await expect(sdk.addChatParticipant("chat-1", { agentName: "peer" })).resolves.toHaveLength(1);
    await expect(sdk.getAgentContextTreeConfig()).resolves.toEqual({ repo: null, branch: null });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://hub.example/api/v1/context-tree/info",
      "https://hub.example/api/v1/agent/config",
      "https://hub.example/api/v1/me/pinned-agents",
      "https://hub.example/api/v1/agent/chats?limit=20&cursor=abc",
      "https://hub.example/api/v1/agent/chats/chat-1",
      "https://hub.example/api/v1/agent/chats/chat-1/messages?limit=10&cursor=m0",
      "https://hub.example/api/v1/agent/chats/chat-1/participants",
      "https://hub.example/api/v1/agent/chats/chat-1/participants",
      "https://hub.example/api/v1/agent/context-tree/info",
    ]);
  });

  it("covers void requests and plain-text SDK errors", async () => {
    makeFetchMock([new Response(null, { status: 204 }), textResponse("plain failure", 409)]);
    const sdk = makeSdk();

    await expect(
      sdk.updateCapabilities("client / 1", {
        codex: {
          state: "ok",
          available: true,
          authenticated: true,
          authMethod: "api_key",
          detectedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).resolves.toBeUndefined();
    await expect(sdk.updateCapabilities("client-2", {})).rejects.toMatchObject({
      name: "SdkError",
      statusCode: 409,
      message: "plain failure",
    });
  });

  it("checks anonymous health reachability with optional user agent", async () => {
    const fetchMock = makeFetchMock([new Response(null, { status: 200 }), new Response(null, { status: 503 })]);
    const sdk = makeSdk();

    await expect(sdk.isHubReachable(25)).resolves.toBe(true);
    await expect(sdk.isHubReachable(25)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/health",
      expect.objectContaining({
        headers: { "User-Agent": "first-tree-test" },
      }),
    );
  });

  it("returns false when the health fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(makeSdk().isHubReachable()).resolves.toBe(false);
  });

  it("covers attention endpoints and query serialization", async () => {
    const fetchMock = makeFetchMock([
      jsonResponse(attention()),
      jsonResponse(attention({ cancelled: true, cancelledReason: "obsolete", state: "closed" })),
      jsonResponse(attention({ cancelled: true, state: "closed" })),
      jsonResponse([attention()]),
      jsonResponse([attention({ id: "att-2" })]),
      jsonResponse(attention()),
    ]);
    const sdk = makeSdk();

    await expect(
      sdk.attention.raise({
        target: "human-1",
        chatId: "chat-1",
        subject: "Need review",
        body: "Please review",
        requiresResponse: true,
        metadata: {},
      }),
    ).resolves.toMatchObject({ id: "att-1" });
    await expect(sdk.attention.cancel("att/1", "obsolete")).resolves.toMatchObject({ cancelled: true });
    await expect(sdk.attention.cancel("att-2")).resolves.toMatchObject({ state: "closed" });
    await expect(sdk.attention.list()).resolves.toHaveLength(1);
    await expect(
      sdk.attention.list({ target: "human-1", chat: "chat-1", agent: "agent-1", state: "open", limit: 5 }),
    ).resolves.toHaveLength(1);
    await expect(sdk.attention.show("att/1")).resolves.toMatchObject({ id: "att-1" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://hub.example/api/v1/agent/attention",
      "https://hub.example/api/v1/agent/attention/att%2F1/cancel",
      "https://hub.example/api/v1/agent/attention/att-2/cancel",
      "https://hub.example/api/v1/agent/attention",
      "https://hub.example/api/v1/agent/attention?target=human-1&chat=chat-1&agent=agent-1&state=open&limit=5",
      "https://hub.example/api/v1/agent/attention/att%2F1",
    ]);
  });

  it("covers private query helpers directly for empty and populated filters", () => {
    const sdk = makeSdk();
    const attentionQueryString = Reflect.get(sdk, "attentionQueryString");
    const queryString = Reflect.get(sdk, "queryString");
    if (typeof attentionQueryString !== "function" || typeof queryString !== "function") {
      throw new Error("missing query helpers");
    }

    expect(attentionQueryString.call(sdk)).toBe("");
    expect(attentionQueryString.call(sdk, {})).toBe("");
    expect(attentionQueryString.call(sdk, { target: "human-1" })).toBe("?target=human-1");
    expect(queryString.call(sdk)).toBe("");
    expect(queryString.call(sdk, { cursor: "next" })).toBe("?cursor=next");
  });

  it("does not retry deterministic non-network fetch failures", async () => {
    const objectError = { cause: { cause: null } };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(objectError).mockRejectedValueOnce("plain failure"));
    const sdk = makeSdk();

    await expect(sdk.listChats()).rejects.toBe(objectError);
    await expect(sdk.listChats()).rejects.toBe("plain failure");
  });

  it("logs retry reasons for retryable Error and non-Error shapes", async () => {
    vi.useFakeTimers();
    const socketError = new Error("socket reset happened");
    Object.assign(socketError, { code: "ECONNRESET" });
    const abortLike = { name: "AbortError" };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(socketError)
      .mockRejectedValueOnce(abortLike)
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(flush(makeSdk().listChats())).resolves.toEqual({ items: [], nextCursor: null });

    expect(warn).toHaveBeenCalledWith("sdk: retry attempt=1 reason=socket reset happened path=/api/v1/agent/chats");
    expect(warn).toHaveBeenCalledWith("sdk: retry attempt=2 reason=unknown path=/api/v1/agent/chats");
  });

  it("merges caller-provided abort signals with the SDK timeout signal", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ ok: true })]);
    const sdk = makeSdk();
    const method = Reflect.get(sdk, "doFetchOnce");
    if (typeof method !== "function") throw new Error("missing doFetchOnce");
    const controller = new AbortController();

    await method.call(sdk, "/api/v1/test", { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/test",
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("falls back to the raw JSON body when an error payload has no error field", async () => {
    makeFetchMock([jsonResponse({}, 400)]);

    await expect(makeSdk().listChats()).rejects.toMatchObject({
      statusCode: 400,
      message: "{}",
    });
  });

  it("keeps requests unscoped when no agent id is configured", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ items: [], nextCursor: null })]);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: () => "access-token",
    });

    expect(sdk.agentId).toBeUndefined();
    await sdk.listChats();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/agent/chats",
      expect.objectContaining({
        headers: { Authorization: "Bearer access-token" },
      }),
    );
  });

  it("constructs SdkError directly", () => {
    const err = new SdkError(418, "teapot");

    expect(err.name).toBe("SdkError");
    expect(err.statusCode).toBe(418);
    expect(err.message).toBe("teapot");
  });
});
