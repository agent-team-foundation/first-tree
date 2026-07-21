import { Writable } from "node:stream";
import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyClientLoggerConfig } from "../observability/logger.js";
import { FirstTreeHubSDK, SdkError } from "../sdk.js";

/**
 * Behavioural coverage for `doFetch`'s retry layer (see
 * docs/sdk-fetch-retry-design.md). Fake timers are used because the fixed
 * `[0, 500ms, 1000ms]` backoff would otherwise add ~1.5s per worst-case
 * test; with fake timers each scenario finishes in real-time microtasks.
 *
 * We drive the SDK through `sendMessage` (which goes via `requestJson` →
 * `doFetch`) rather than calling `doFetch` directly: `doFetch` is private,
 * and exercising it via the public surface also guards against accidentally
 * swapping the retry layer out behind one of the public methods.
 */

const SERVER_URL = "https://first-tree.example";
const CHAT_ID = "chat-1";

function makeOkResponse(): Response {
  return new Response(JSON.stringify({ id: "m-1", chatId: CHAT_ID, content: "hi" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeStatusResponse(status: number, body = ""): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function makeCreateOkResponse(): Response {
  return new Response(
    JSON.stringify({
      chatId: "chat-created",
      messageId: "msg-created",
      topic: null,
      effectiveSenderId: "agent-1",
      initialRecipientAgentIds: ["agent-2"],
      contextParticipantAgentIds: [],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeKeyedCreateOkResponse(): Response {
  return new Response(
    JSON.stringify({
      chatId: "chat-review",
      messageId: "msg-review",
      topic: "Context Review · context-tree#749",
      effectiveSenderId: "human-1",
      reviewerAgentUuid: "reviewer-1",
      outcome: "reused",
      managedReviewReceiptV1: {
        schemaVersion: 1,
        repository: "owner/context-tree",
        pullRequest: 749,
        expectedHead: "a".repeat(40),
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeLegacyKeyedCreateResponse(): Response {
  return new Response(
    JSON.stringify({
      chatId: "chat-review",
      messageId: "msg-review",
      topic: "Context Review · context-tree#749",
      effectiveSenderId: "human-1",
      reviewerAgentUuid: "reviewer-1",
      outcome: "created",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function keyedTaskPayload() {
  return {
    mode: "keyed_task" as const,
    initialMessage: {
      format: "markdown" as const,
      content: "Please review this Context Tree PR.",
      metadata: {
        taskType: "context_tree_pr_review" as const,
        reviewPacketV1: {
          schemaVersion: 1 as const,
          repository: "owner/context-tree",
          pullRequest: 749,
          expectedHead: "a".repeat(40),
          baseRef: "main",
          sourceRef: "agent-review-contract",
          requesterGithubLogin: "writer",
          goal: "Record the approved Agent Review contract.",
          source: { label: "Architecture discussion", reference: "first-tree-chat:agent-review-contract" },
          decisionSummary: "Use the existing member task Chat.",
          rationale: "This preserves the normal Chat and Inbox boundary.",
          targetPaths: ["system/context-tree-pr-reviewer.md"],
          repairScope: ["system/context-tree-pr-reviewer.md"],
          relevantContextRefs: [],
          unresolvedQuestions: [],
          verify: { status: "passed" as const, summary: "first-tree tree verify passed" },
          evidence: [],
        },
      },
    },
  };
}

function makeFetchFailed(): TypeError {
  // Real undici shape: top-level `TypeError("fetch failed")` with `cause`
  // pointing at the underlying socket error. We don't need a real cause
  // for retry-decision purposes — the top-level message match is enough.
  return new TypeError("fetch failed");
}

function makeAbortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Node 22+ shape for `AbortSignal.timeout()` firings: a `DOMException` whose
 * `name` is `"TimeoutError"` (Web spec), NOT `AbortError`. The previous
 * `isTransientNetworkError` matched only on `AbortError`, so real production
 * timeouts skipped the retry layer entirely. This factory captures the
 * actual runtime shape (verified against a v0.5.x bind-aborted log).
 */
function makeTimeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/**
 * Schedules a body returning the `n`-th item of `results` per call. Each item
 * is either a `Response` (resolved) or an `Error` (rejected).
 */
function buildFetchMock(results: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const item of results) {
    if (item instanceof Error) {
      fetchMock.mockImplementationOnce(() => Promise.reject(item));
    } else {
      fetchMock.mockImplementationOnce(() => Promise.resolve(item));
    }
  }
  return fetchMock;
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

/**
 * Drive an async expression to completion under fake timers. Each iteration
 * flushes microtasks (so the awaited `setTimeout` registers its scheduler
 * call) and then drains pending timers. Stops when the promise settles. A
 * conservative `maxFlushes` cap prevents an infinite loop in case the SUT
 * regresses into a busy-loop.
 */
async function flush<T>(promise: Promise<T>, maxFlushes = 50): Promise<T> {
  let settled = false;
  let result: T | undefined;
  let error: unknown;
  promise.then(
    (v) => {
      result = v;
      settled = true;
    },
    (e) => {
      error = e;
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

function makeSdk(): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl: SERVER_URL,
    getAccessToken: () => "tok-test",
  });
}

describe("FirstTreeHubSDK doFetch retry layer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    applyClientLoggerConfig({ level: "silent", format: "json", destination: process.stderr, explicit: false });
  });

  it("retries through two transient fetch-failed errors and succeeds on the third attempt", async () => {
    const fetchMock = buildFetchMock([makeFetchFailed(), makeFetchFailed(), makeOkResponse()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    const result = await flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ id: "m-1", chatId: CHAT_ID });
  });

  it("rethrows after three failed fetch-failed attempts", async () => {
    const fetchMock = buildFetchMock([makeFetchFailed(), makeFetchFailed(), makeFetchFailed()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    await expect(flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" }))).rejects.toThrow(
      /fetch failed/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry on HTTP 400 — propagates an SdkError after one attempt", async () => {
    const fetchMock = buildFetchMock([makeStatusResponse(400, JSON.stringify({ error: "bad input" }))]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    await expect(
      flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" })),
    ).rejects.toBeInstanceOf(SdkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry createTaskChat when the result is uncertain", async () => {
    const http500 = buildFetchMock([makeStatusResponse(500, "maybe created"), makeCreateOkResponse()]);
    vi.stubGlobal("fetch", http500);

    await expect(
      flush(
        makeSdk().createTaskChat({
          mode: "task",
          initialRecipientAgentIds: ["agent-2"],
          initialRecipientNames: [],
          contextParticipantAgentIds: [],
          contextParticipantNames: [],
          initialMessage: { source: "cli", format: "text", content: "start task" },
        }),
      ),
    ).rejects.toBeInstanceOf(SdkError);
    expect(http500).toHaveBeenCalledTimes(1);

    const networkFailure = buildFetchMock([makeFetchFailed(), makeCreateOkResponse()]);
    vi.stubGlobal("fetch", networkFailure);
    await expect(
      flush(
        makeSdk().createTaskChat({
          mode: "task",
          initialRecipientAgentIds: ["agent-2"],
          initialRecipientNames: [],
          contextParticipantAgentIds: [],
          contextParticipantNames: [],
          initialMessage: { source: "cli", format: "text", content: "start task" },
        }),
      ),
    ).rejects.toThrow(/fetch failed/);
    expect(networkFailure).toHaveBeenCalledTimes(1);
  });

  it("safely retries member keyed task creation and returns the converged result", async () => {
    const fetchMock = buildFetchMock([makeStatusResponse(500, "result unknown"), makeKeyedCreateOkResponse()]);
    vi.stubGlobal("fetch", fetchMock);

    const result = await flush(makeSdk().createMemberKeyedTaskChat("org-1", keyedTaskPayload()));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://first-tree.example/api/v1/orgs/org-1/chats");
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body);
    for (const [, init] of fetchMock.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer tok-test");
      expect(headers.has(AGENT_SELECTOR_HEADER)).toBe(false);
      expect(headers.has(AGENT_RUNTIME_SESSION_HEADER)).toBe(false);
    }
    expect(result).toEqual({
      chatId: "chat-review",
      messageId: "msg-review",
      topic: "Context Review · context-tree#749",
      effectiveSenderId: "human-1",
      reviewerAgentUuid: "reviewer-1",
      outcome: "reused",
      managedReviewReceiptV1: {
        schemaVersion: 1,
        repository: "owner/context-tree",
        pullRequest: 749,
        expectedHead: "a".repeat(40),
      },
    });
  });

  it("identifies an older Server that cannot return the required managed receipt", async () => {
    const fetchMock = buildFetchMock([makeLegacyKeyedCreateResponse()]);
    vi.stubGlobal("fetch", fetchMock);

    await expect(flush(makeSdk().createMemberKeyedTaskChat("org-1", keyedTaskPayload()))).rejects.toMatchObject({
      name: "SdkError",
      statusCode: 426,
      code: "MANAGED_REVIEW_SERVER_TOO_OLD",
      message: expect.stringContaining("missing managedReviewReceiptV1"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on HTTP 500 and succeeds on the second attempt", async () => {
    const { dest, read } = collectLogs();
    applyClientLoggerConfig({ level: "warn", format: "json", destination: dest });
    const fetchMock = buildFetchMock([makeStatusResponse(500, "boom"), makeOkResponse()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    const result = await flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ id: "m-1" });
    expect(read()).toContain('"module":"sdk"');
    expect(read()).toContain("retry attempt=1 reason=http-500 path=");
  });

  it("treats AbortError (timeout) as transient and retries up to three times", async () => {
    const fetchMock = buildFetchMock([makeAbortError(), makeAbortError(), makeAbortError()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    await expect(
      flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" })),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("treats TimeoutError (real AbortSignal.timeout shape) as transient and retries up to three times", async () => {
    const fetchMock = buildFetchMock([makeTimeoutError(), makeTimeoutError(), makeTimeoutError()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    await expect(
      flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" })),
    ).rejects.toHaveProperty("name", "TimeoutError");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries through two TimeoutErrors and succeeds on the third attempt (the prod bind-aborted scenario)", async () => {
    const fetchMock = buildFetchMock([makeTimeoutError(), makeTimeoutError(), makeOkResponse()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    const result = await flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ id: "m-1" });
  });

  it("adds the runtime session header on agent-scoped HTTP requests", async () => {
    const fetchMock = buildFetchMock([makeOkResponse()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: () => "tok-test",
      agentId: "agent-1",
      runtimeSessionToken: "runtime-token-1",
    });
    await flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" }));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok-test",
      [AGENT_SELECTOR_HEADER]: "agent-1",
      [AGENT_RUNTIME_SESSION_HEADER]: "runtime-token-1",
    });
  });
});
