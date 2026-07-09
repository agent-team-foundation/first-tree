import { Writable } from "node:stream";
import { AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyClientLoggerConfig } from "../observability/logger.js";
import { FirstTreeHubSDK, SdkError } from "../sdk.js";

const SERVER_URL = "https://first-tree.example/";

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

function collectLogs(): { dest: Writable; read: () => string } {
  const chunks: string[] = [];
  const dest = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { dest, read: () => chunks.join("") };
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

describe("FirstTreeHubSDK public surface", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });
  });

  it("normalizes serverUrl and exposes the scoped agent id", () => {
    const sdk = makeSdk();

    expect(sdk.serverUrl).toBe("https://first-tree.example");
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
      "https://first-tree.example/api/v1/agent/chats/chat-1/messages",
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
      "https://first-tree.example/api/v1/context-tree/info",
      "https://first-tree.example/api/v1/agent/config",
      "https://first-tree.example/api/v1/me/pinned-agents",
      "https://first-tree.example/api/v1/agent/chats?limit=20&cursor=abc",
      "https://first-tree.example/api/v1/agent/chats/chat-1",
      "https://first-tree.example/api/v1/agent/chats/chat-1/messages?limit=10&cursor=m0",
      "https://first-tree.example/api/v1/agent/chats/chat-1/participants",
      "https://first-tree.example/api/v1/agent/chats/chat-1/participants",
      "https://first-tree.example/api/v1/agent/context-tree/info",
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
          runtimeSource: "bundled",
          runtimePath: null,
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

  it("preserves Retry-After on SDK errors for provider backoff policy", async () => {
    makeFetchMock([
      new Response(JSON.stringify({ error: "Rate limit exceeded, retry in 53 seconds" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "53" },
      }),
    ]);

    await expect(makeSdk().listChats()).rejects.toMatchObject({
      name: "SdkError",
      statusCode: 429,
      message: "Rate limit exceeded, retry in 53 seconds",
      retryAfter: "53",
      retryAfterMs: 53_000,
    });
  });

  it("checks anonymous health reachability with optional user agent", async () => {
    const fetchMock = makeFetchMock([new Response(null, { status: 200 }), new Response(null, { status: 503 })]);
    const sdk = makeSdk();

    await expect(sdk.isHubReachable(25)).resolves.toBe(true);
    await expect(sdk.isHubReachable(25)).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/health",
      expect.objectContaining({
        headers: { "User-Agent": "first-tree-test" },
      }),
    );
  });

  it("returns false when the health fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(makeSdk().isHubReachable()).resolves.toBe(false);
  });

  it("covers private query helpers directly for empty and populated filters", () => {
    const sdk = makeSdk();
    const queryString = Reflect.get(sdk, "queryString");
    if (typeof queryString !== "function") {
      throw new Error("missing query helpers");
    }

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

  it("logs retry reasons through the client logger for retryable Error and non-Error shapes", async () => {
    vi.useFakeTimers();
    const { dest, read } = collectLogs();
    applyClientLoggerConfig({ level: "warn", format: "json", destination: dest });
    const socketError = new Error("socket reset happened");
    Object.assign(socketError, { code: "ECONNRESET" });
    const abortLike = { name: "AbortError" };
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(socketError)
      .mockRejectedValueOnce(abortLike)
      .mockResolvedValueOnce(jsonResponse({ items: [], nextCursor: null }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(flush(makeSdk().listChats())).resolves.toEqual({ items: [], nextCursor: null });

    expect(read()).toContain('"module":"sdk"');
    expect(read()).toContain("retry attempt=1 reason=socket reset happened path=/api/v1/agent/chats");
    expect(read()).toContain("retry attempt=2 reason=unknown path=/api/v1/agent/chats");
  });

  it("merges caller-provided abort signals with the SDK timeout signal", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ ok: true })]);
    const sdk = makeSdk();
    const method = Reflect.get(sdk, "doFetchOnce");
    if (typeof method !== "function") throw new Error("missing doFetchOnce");
    const controller = new AbortController();

    await method.call(sdk, "/api/v1/test", { signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/test",
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
      "https://first-tree.example/api/v1/agent/chats",
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

  it("covers outbox token, active runtime chat ids, chat update, and github entity endpoints", async () => {
    const conflictBody = {
      error: "ENTITY_FOLLOWED_ELSEWHERE",
      message: "already followed",
      conflict: { chatId: "chat-other", topic: "Other" },
    };
    const fetchMock = makeFetchMock([
      jsonResponse({ accessToken: "outbox-token", expiresIn: 60 }),
      jsonResponse({ chatIds: ["chat-1", "chat-2"] }),
      jsonResponse({ id: "chat-1", topic: "Updated" }),
      jsonResponse({ entity: "acme/backend", chatId: "chat-1" }),
      new Response(JSON.stringify(conflictBody), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
      new Response("not json conflict", { status: 409, headers: { "content-type": "text/plain" } }),
      new Response(JSON.stringify({ error: "nope" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
      new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
      jsonResponse({ removed: 1 }),
      jsonResponse({ entities: [{ entity: "acme/backend" }] }),
    ]);
    const sdk = makeSdk();

    await expect(sdk.createAgentOutboxToken("chat-1")).resolves.toEqual({
      accessToken: "outbox-token",
      expiresIn: 60,
    });
    await expect(sdk.listActiveRuntimeChatIds()).resolves.toEqual({ chatIds: ["chat-1", "chat-2"] });
    await expect(sdk.updateChat("chat-1", { topic: "Updated", description: null })).resolves.toMatchObject({
      id: "chat-1",
    });
    await expect(sdk.followGithubEntity("chat-1", { entity: "acme/backend" })).resolves.toEqual({
      ok: true,
      result: { entity: "acme/backend", chatId: "chat-1" },
    });
    await expect(sdk.followGithubEntity("chat-1", { entity: "acme/backend", rebind: true })).resolves.toEqual({
      ok: false,
      conflict: conflictBody,
    });
    await expect(sdk.followGithubEntity("chat-1", { entity: "acme/backend" })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("non-JSON conflict body"),
    });
    await expect(sdk.followGithubEntity("chat-1", { entity: "acme/backend" })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("malformed conflict body"),
    });
    await expect(sdk.followGithubEntity("chat-1", { entity: "missing" })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(sdk.unfollowGithubEntity("chat-1", "acme/backend")).resolves.toEqual({ removed: 1 });
    await expect(sdk.listChatGithubEntities("chat-1")).resolves.toEqual({ entities: [{ entity: "acme/backend" }] });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://first-tree.example/api/v1/agent/chats/chat-1/outbox-token",
      "https://first-tree.example/api/v1/agent/chats/active-runtime-ids",
      "https://first-tree.example/api/v1/agent/chats/chat-1",
      "https://first-tree.example/api/v1/agent/chats/chat-1/github-entities",
      "https://first-tree.example/api/v1/agent/chats/chat-1/github-entities",
      "https://first-tree.example/api/v1/agent/chats/chat-1/github-entities",
      "https://first-tree.example/api/v1/agent/chats/chat-1/github-entities",
      "https://first-tree.example/api/v1/agent/chats/chat-1/github-entities",
      "https://first-tree.example/api/v1/agent/chats/chat-1/github-entities?entity=acme%2Fbackend",
      "https://first-tree.example/api/v1/agent/chats/chat-1/github-entities",
    ]);
  });

  it("covers attachment upload/download including content-disposition filename parsing", async () => {
    const uploadBody = {
      id: "019e71c9-88d2-70be-be67-fdb033b2ef0b",
      mimeType: "image/png",
      filename: "shot.png",
      sizeBytes: 4,
      uploadedBy: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const bytes = Buffer.from([1, 2, 3, 4]);
    const fetchMock = makeFetchMock([
      jsonResponse(uploadBody),
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-disposition": 'attachment; filename="shot%20copy.png"',
        },
      }),
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
        },
      }),
      new Response(bytes, {
        status: 200,
        headers: {
          "content-disposition": 'attachment; filename="%E0%A4%A"',
        },
      }),
      new Response(bytes, {
        status: 200,
        headers: {
          "content-disposition": "inline",
        },
      }),
      textResponse("missing", 404),
    ]);
    const sdk = makeSdk();

    await expect(
      sdk.uploadAttachment({
        bytes,
        mimeType: "image/png",
        filename: "shot.png",
        orgId: "org/1",
      }),
    ).resolves.toEqual(uploadBody);

    const withName = await sdk.fetchAttachment({ id: "att-1" });
    expect(withName.mimeType).toBe("image/png");
    expect(withName.filename).toBe("shot copy.png");
    expect(withName.size).toBe(4);
    expect(Buffer.compare(withName.bytes, bytes)).toBe(0);

    const defaults = await sdk.fetchAttachment({ id: "att-2" });
    expect(defaults.mimeType).toBe("application/octet-stream");
    expect(defaults.filename).toBe("blob");

    const malformedEncoding = await sdk.fetchAttachment({ id: "att-3" });
    expect(malformedEncoding.filename).toBe("%E0%A4%A");

    const noFilenameDirective = await sdk.fetchAttachment({ id: "att-4" });
    expect(noFilenameDirective.filename).toBe("blob");

    await expect(sdk.fetchAttachment({ id: "missing" })).rejects.toMatchObject({ statusCode: 404 });

    const uploadCall = fetchMock.mock.calls[0];
    expect(uploadCall?.[0]).toBe("https://first-tree.example/api/v1/orgs/org%2F1/attachments");
    expect(uploadCall?.[1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        "Content-Type": "application/octet-stream",
      }),
    });
  });

  it("covers document publish/list/get/status and comment lifecycle without transport retry", async () => {
    const fetchMock = makeFetchMock([
      jsonResponse({ id: "doc-1", slug: "plan", version: 1 }),
      jsonResponse({ items: [{ id: "doc-1" }], nextCursor: null }),
      jsonResponse({ id: "doc-1", version: { number: 2, content: "# hi" } }),
      jsonResponse({ id: "doc-1", status: "published" }),
      jsonResponse({ items: [{ id: "c1" }] }),
      jsonResponse({ id: "c1", body: "nit" }),
      jsonResponse({ id: "c2", body: "reply" }),
      jsonResponse({ id: "c1", status: "resolved" }),
      textResponse("boom", 500),
      textResponse("boom", 500),
      textResponse("boom", 500),
    ]);
    const sdk = makeSdk();

    await expect(
      sdk.publishDoc({ slug: "plan", title: "Plan", content: "# hi", project: "alpha" }),
    ).resolves.toMatchObject({ id: "doc-1" });
    await expect(
      sdk.listDocs({ slug: "plan", project: "alpha", status: "draft", limit: 5, cursor: "c0" }),
    ).resolves.toMatchObject({ nextCursor: null });
    await expect(sdk.getDoc("doc-1", { version: 2 })).resolves.toMatchObject({ id: "doc-1" });
    await expect(sdk.setDocStatus("doc-1", "published")).resolves.toMatchObject({ status: "published" });
    await expect(sdk.listDocComments("doc-1", { status: "open", versionNumber: 1 })).resolves.toMatchObject({
      items: [{ id: "c1" }],
    });
    await expect(sdk.createDocComment("doc-1", { body: "nit" })).resolves.toMatchObject({ id: "c1" });
    await expect(sdk.replyDocComment("c1", "reply")).resolves.toMatchObject({ id: "c2" });
    await expect(sdk.setDocCommentStatus("c1", "resolved")).resolves.toMatchObject({ status: "resolved" });

    // publishDoc is non-idempotent — transport retry is disabled.
    await expect(sdk.publishDoc({ slug: "fail", title: "Fail", content: "x" })).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(9);

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://first-tree.example/api/v1/agent/documents",
      "https://first-tree.example/api/v1/agent/documents?slug=plan&project=alpha&status=draft&limit=5&cursor=c0",
      "https://first-tree.example/api/v1/agent/documents/doc-1?version=2",
      "https://first-tree.example/api/v1/agent/documents/doc-1",
      "https://first-tree.example/api/v1/agent/documents/doc-1/comments?status=open&versionNumber=1",
      "https://first-tree.example/api/v1/agent/documents/doc-1/comments",
      "https://first-tree.example/api/v1/agent/document-comments/c1/replies",
      "https://first-tree.example/api/v1/agent/document-comments/c1",
      "https://first-tree.example/api/v1/agent/documents",
    ]);
  });

  it("parses HTTP-date Retry-After and ignores invalid values", async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    makeFetchMock([
      new Response(JSON.stringify({ error: "later" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": future },
      }),
      new Response(JSON.stringify({ error: "nope" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "not-a-date" },
      }),
    ]);

    const withDate = await makeSdk()
      .listChats()
      .then(
        () => {
          throw new Error("expected rejection");
        },
        (err: unknown) => err as SdkError,
      );
    expect(withDate.retryAfter).toBe(future);
    expect(withDate.retryAfterMs).toBeGreaterThan(0);

    const invalid = await makeSdk()
      .listChats()
      .then(
        () => {
          throw new Error("expected rejection");
        },
        (err: unknown) => err as SdkError,
      );
    expect(invalid.retryAfter).toBe("not-a-date");
    expect(invalid.retryAfterMs).toBeUndefined();
  });

  it("exposes runtimeSessionToken and merges custom headers over defaults", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ ok: true })]);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      agentId: "agent-1",
      runtimeSessionToken: "runtime-token-xyz",
      getAccessToken: () => "access-token",
    });

    expect(sdk.runtimeSessionToken).toBe("runtime-token-xyz");

    const method = Reflect.get(sdk, "doFetchOnce");
    if (typeof method !== "function") throw new Error("missing doFetchOnce");
    await method.call(sdk, "/api/v1/test", {
      method: "POST",
      body: Buffer.from("raw"),
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Custom": "1",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://first-tree.example/api/v1/test",
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/octet-stream",
          "X-Custom": "1",
          "x-agent-runtime-session": "runtime-token-xyz",
        }),
      }),
    );
  });

  it("covers buildQuery empty/populated branches via listDocs", async () => {
    const fetchMock = makeFetchMock([jsonResponse({ items: [], nextCursor: null })]);
    await makeSdk().listDocs();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://first-tree.example/api/v1/agent/documents");
  });
});
