import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK, SdkError } from "../sdk.js";

const SERVER_URL = "https://first-tree.example";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(...results: unknown[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  for (const result of results) {
    if (result instanceof Response) {
      fetchMock.mockResolvedValueOnce(result);
    } else {
      fetchMock.mockRejectedValueOnce(result);
    }
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeSdk(): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl: SERVER_URL,
    agentId: "agent-1",
    getAccessToken: () => "access-token",
    runtimeSessionToken: () => "runtime-token",
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("cron SDK revisioned mutations", () => {
  it("does not retry updateCronJob after a transient network failure", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(new TypeError("fetch failed"), jsonResponse({ id: "job-1" }));
    const sdk = makeSdk();
    const pending = sdk.updateCronJob("chat-1", "job-1", { prompt: "x" }, 3);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry deleteCronJob after HTTP 500", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(
      jsonResponse({ error: "boom" }, 500),
      jsonResponse({ id: "job-1", deleted: true, acceptedWorkPreserved: false, lastTriggerMessageId: null }),
    );
    const sdk = makeSdk();
    const pending = sdk.deleteCronJob("chat-1", "job-1", 2);
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).rejects.toBeInstanceOf(SdkError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends If-Match exactly once for a successful update", async () => {
    const fetchMock = mockFetch(jsonResponse({ id: "job-1", revision: 4 }));
    const sdk = makeSdk();
    await sdk.updateCronJob("chat-1", "job-1", { state: "paused" }, 3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get("If-Match")).toBe("3");
  });
});
