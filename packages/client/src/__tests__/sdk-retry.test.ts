import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const SERVER_URL = "https://hub.example";
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
    // Suppress the deliberate `console.warn` retry logs in the SUT so test
    // output stays readable. We do not assert on the log text itself —
    // those are diagnostic, not contractual.
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("retries on HTTP 500 and succeeds on the second attempt", async () => {
    const fetchMock = buildFetchMock([makeStatusResponse(500, "boom"), makeOkResponse()]);
    vi.stubGlobal("fetch", fetchMock);

    const sdk = makeSdk();
    const result = await flush(sdk.sendMessage(CHAT_ID, { source: "api", format: "text", content: "hi" }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ id: "m-1" });
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
});
