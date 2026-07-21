import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK, type SdkError } from "../sdk.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("FirstTreeHubSDK.submitContextReview", () => {
  it("sends agent and runtime-session proof to the narrow run endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          action: "APPROVE",
          reviewedHead: "a".repeat(40),
          reviewId: 42,
          reviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-42",
          appActor: "first-tree[bot]",
          publicationDisposition: "created",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://cloud.example",
      getAccessToken: () => "member-jwt",
      agentId: "agent/reviewer",
      runtimeSessionToken: "runtime-proof",
    });

    await sdk.submitContextReview("chat/id", "run/id", {
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      body: "Approved.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://cloud.example/api/v1/agent/chats/chat%2Fid/context-review-runs/run%2Fid/submit");
    expect(new Headers(init?.headers).get("x-agent-id")).toBe("agent/reviewer");
    expect(new Headers(init?.headers).get("x-agent-runtime-session")).toBe("runtime-proof");
    expect(JSON.parse(String(init?.body))).toEqual({
      reviewedHead: "a".repeat(40),
      event: "APPROVE",
      body: "Approved.",
    });
  });

  it("sends runtime proof to the read-only run authority endpoint without retry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          authorized: true,
          repository: "o/r",
          prNumber: 7,
          reviewedHead: "a".repeat(40),
          state: "open",
          draft: false,
          baseRef: "main",
          headRef: "context-update",
          headRepository: "o/r",
          sameRepository: true,
          installationId: 42,
          reviewerClientId: "client-1",
          runtimeSessionBoundAt: "2026-07-21T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchMock;
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://cloud.example",
      getAccessToken: () => "member-jwt",
      agentId: "agent/reviewer",
      runtimeSessionToken: "runtime-proof",
    });

    await sdk.inspectContextReviewAuthority("chat/id", "run/id", { reviewedHead: "a".repeat(40) });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://cloud.example/api/v1/agent/chats/chat%2Fid/context-review-runs/run%2Fid/authority");
    expect(new Headers(init?.headers).get("x-agent-runtime-session")).toBe("runtime-proof");
    expect(JSON.parse(String(init?.body))).toEqual({ reviewedHead: "a".repeat(40) });
  });

  it("does not retry a transient response for the mutation endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "delivery unknown", code: "CONTEXT_REVIEW_GITHUB_UNKNOWN" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    globalThis.fetch = fetchMock;
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://cloud.example",
      getAccessToken: () => "member-jwt",
      agentId: "agent",
      runtimeSessionToken: "runtime-proof",
    });
    await expect(
      sdk.submitContextReview("chat", "run", {
        reviewedHead: "b".repeat(40),
        event: "COMMENT",
        body: "Deferred.",
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "CONTEXT_REVIEW_GITHUB_UNKNOWN",
      message: "delivery unknown",
    } satisfies Partial<SdkError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
