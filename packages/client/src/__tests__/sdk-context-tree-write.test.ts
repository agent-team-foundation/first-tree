import { AGENT_RUNTIME_SESSION_HEADER, AGENT_SELECTOR_HEADER } from "@first-tree/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FirstTreeHubSDK, SdkError } from "../sdk.js";

const SERVER_URL = "https://first-tree.example";
const REPO = "git@github.com:acme/context-tree.git";

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

function requestInit(fetchMock: ReturnType<typeof vi.fn>, index: number): RequestInit {
  const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
  if (!init) throw new Error(`missing fetch init at call ${index}`);
  return init;
}

function makeSdk(overrides: Partial<ConstructorParameters<typeof FirstTreeHubSDK>[0]> = {}): FirstTreeHubSDK {
  return new FirstTreeHubSDK({
    serverUrl: SERVER_URL,
    agentId: "agent-1",
    getAccessToken: () => "access-token",
    runtimeSessionToken: () => "runtime-token",
    ...overrides,
  });
}

async function flushWithTimers<T>(promise: Promise<T>, maxFlushes = 10): Promise<T> {
  const box: {
    outcome: { kind: "pending" } | { kind: "resolved"; value: T } | { kind: "rejected"; reason: unknown };
  } = {
    outcome: { kind: "pending" },
  };
  promise.then(
    (value) => {
      box.outcome = { kind: "resolved", value };
    },
    (reason) => {
      box.outcome = { kind: "rejected", reason };
    },
  );
  for (let index = 0; index < maxFlushes && box.outcome.kind === "pending"; index++) {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
  }
  const outcome = box.outcome;
  if (outcome.kind === "pending") throw new Error("SDK request did not settle within the fake-timer budget");
  if (outcome.kind === "rejected") throw outcome.reason;
  return outcome.value;
}

describe("FirstTreeHubSDK.setAgentContextTreeConfig", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("resolves the agent organization before the encoded org settings PUT with dynamic auth headers", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ organizationId: "org /?#" }),
      jsonResponse({ repo: REPO, branch: "release" }),
    );
    let accessTokenVersion = 0;
    let runtimeTokenVersion = 0;
    const getAccessToken = vi.fn(() => `access-token-${++accessTokenVersion}`);
    const runtimeSessionToken = vi.fn(() => `runtime-token-${++runtimeTokenVersion}`);
    const sdk = makeSdk({ getAccessToken, runtimeSessionToken });

    await expect(sdk.setAgentContextTreeConfig({ repo: REPO, branch: "release" })).resolves.toEqual({
      repo: REPO,
      branch: "release",
    });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      `${SERVER_URL}/api/v1/agent/me`,
      `${SERVER_URL}/api/v1/orgs/org%20%2F%3F%23/settings/context_tree`,
    ]);
    expect(requestInit(fetchMock, 0)).toEqual(
      expect.objectContaining({
        redirect: "manual",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token-1",
          [AGENT_SELECTOR_HEADER]: "agent-1",
          [AGENT_RUNTIME_SESSION_HEADER]: "runtime-token-1",
        }),
      }),
    );
    expect(requestInit(fetchMock, 0).method).toBeUndefined();
    expect(requestInit(fetchMock, 0).body).toBeUndefined();
    expect(requestInit(fetchMock, 1)).toEqual(
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ repo: REPO, branch: "release" }),
        redirect: "manual",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token-2",
          [AGENT_SELECTOR_HEADER]: "agent-1",
          [AGENT_RUNTIME_SESSION_HEADER]: "runtime-token-2",
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(runtimeSessionToken).toHaveBeenCalledTimes(2);
    expect(urls).not.toContain(`${SERVER_URL}/api/v1/me`);
    expect(urls).not.toContain(`${SERVER_URL}/api/v1/context-tree/info`);
    expect(urls).not.toContain(`${SERVER_URL}/api/v1/agent/context-tree/info`);
  });

  it("omits branch from the PUT body when the caller does not provide it", async () => {
    const fetchMock = mockFetch(
      jsonResponse({ organizationId: "org-1" }),
      jsonResponse({ repo: REPO, branch: "main" }),
    );

    await expect(makeSdk().setAgentContextTreeConfig({ repo: REPO })).resolves.toEqual({
      repo: REPO,
      branch: "main",
    });

    expect(requestInit(fetchMock, 1).body).toBe(JSON.stringify({ repo: REPO }));
  });

  it("rejects an agent organization redirect without following it or issuing the PUT", async () => {
    const fetchMock = mockFetch(
      new Response(null, { status: 307, headers: { location: "https://other.example/api/v1/agent/me" } }),
      jsonResponse({ repo: REPO, branch: "main" }),
    );

    await expect(makeSdk().setAgentContextTreeConfig({ repo: REPO })).rejects.toMatchObject({ statusCode: 307 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`${SERVER_URL}/api/v1/agent/me`);
    expect(requestInit(fetchMock, 0).redirect).toBe("manual");
  });

  it("retains read retries for agent organization resolution while sending the PUT once", async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetch(
      jsonResponse({ error: "temporarily unavailable" }, 503),
      jsonResponse({ organizationId: "org-1" }),
      jsonResponse({ repo: REPO, branch: "main" }),
    );

    let accessTokenVersion = 0;
    let runtimeTokenVersion = 0;
    const sdk = makeSdk({
      getAccessToken: () => `access-token-${++accessTokenVersion}`,
      runtimeSessionToken: () => `runtime-token-${++runtimeTokenVersion}`,
    });

    await expect(flushWithTimers(sdk.setAgentContextTreeConfig({ repo: REPO }))).resolves.toEqual({
      repo: REPO,
      branch: "main",
    });

    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `${SERVER_URL}/api/v1/agent/me`,
      `${SERVER_URL}/api/v1/agent/me`,
      `${SERVER_URL}/api/v1/orgs/org-1/settings/context_tree`,
    ]);
    expect(fetchMock.mock.calls.map((_call, index) => requestInit(fetchMock, index).redirect)).toEqual([
      "manual",
      "manual",
      "manual",
    ]);
    expect(
      fetchMock.mock.calls.map(
        (_call, index) => (requestInit(fetchMock, index).headers as Record<string, string>).Authorization,
      ),
    ).toEqual(["Bearer access-token-1", "Bearer access-token-2", "Bearer access-token-3"]);
    expect(
      fetchMock.mock.calls.map(
        (_call, index) =>
          (requestInit(fetchMock, index).headers as Record<string, string>)[AGENT_RUNTIME_SESSION_HEADER],
      ),
    ).toEqual(["runtime-token-1", "runtime-token-2", "runtime-token-3"]);
  });

  it.each([
    ["null response", null],
    ["missing organizationId", {}],
    ["non-string organizationId", { organizationId: 42 }],
    ["empty organizationId", { organizationId: "" }],
    ["whitespace-only organizationId", { organizationId: " \t" }],
    ["leading whitespace", { organizationId: " org-1" }],
    ["trailing whitespace", { organizationId: "org-1\n" }],
  ])("rejects %s without issuing the PUT", async (_name, agentResponse) => {
    const fetchMock = mockFetch(jsonResponse(agentResponse), jsonResponse({ repo: REPO, branch: "main" }));

    await expect(makeSdk().setAgentContextTreeConfig({ repo: REPO })).rejects.toThrow(
      "organizationId must be a non-empty, unpadded string",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([`${SERVER_URL}/api/v1/agent/me`]);
  });

  it.each([
    ["HTTP redirect", () => new Response(null, { status: 307, headers: { location: "https://other.example" } })],
    ["HTTP 5xx", () => jsonResponse({ error: "unavailable" }, 503)],
    ["network failure", () => new TypeError("fetch failed")],
    ["timeout", () => new DOMException("The operation timed out", "TimeoutError")],
  ])("does not retry the PUT after %s", async (_name, makeFailure) => {
    const failure = makeFailure();
    const fetchMock = mockFetch(
      jsonResponse({ organizationId: "org-1" }),
      failure,
      jsonResponse({ repo: REPO, branch: "main" }),
    );
    const promise = makeSdk().setAgentContextTreeConfig({ repo: REPO });

    if (failure instanceof Response) {
      await expect(promise).rejects.toBeInstanceOf(SdkError);
    } else {
      await expect(promise).rejects.toBe(failure);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      `${SERVER_URL}/api/v1/agent/me`,
      `${SERVER_URL}/api/v1/orgs/org-1/settings/context_tree`,
    ]);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("FirstTreeHubSDK.preflightMemberContextTreeWrite", () => {
  it("uses only the explicit Team member route and returns Server current authority", async () => {
    const authority = {
      organizationId: "team /?#",
      provider: "github",
      binding: { provider: "github", repo: "https://github.com/acme/context-tree.git", branch: "main" },
      gitlabInstanceOrigin: null,
      reviewerAgentUuid: "reviewer-current",
      requesterGithubLogin: "Writer",
    };
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) =>
      Promise.resolve(
        new Response(JSON.stringify(authority), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: async () => "member-access-token",
    });

    await expect(
      sdk.preflightMemberContextTreeWrite("team /?#", { requesterGithubLogin: " Writer " }, { retry: false }),
    ).resolves.toEqual(authority);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${SERVER_URL}/api/v1/orgs/team%20%2F%3F%23/context-tree/write-preflight`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ requesterGithubLogin: "Writer" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer member-access-token");
    expect(headers.has(AGENT_SELECTOR_HEADER)).toBe(false);
    expect(headers.has(AGENT_RUNTIME_SESSION_HEADER)).toBe(false);
  });

  it("rejects caller-selected Reviewer authority before transport", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: async () => "member-access-token",
    });

    await expect(
      sdk.preflightMemberContextTreeWrite(
        "team-a",
        { requesterGithubLogin: "writer", reviewerAgentUuid: "caller-selected" } as never,
        { retry: false },
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not hide a transport failure behind a second authority check when retries are disabled", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "temporarily unavailable" }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          organizationId: "team-a",
          binding: { repo: "https://github.com/acme/context-tree.git", branch: "main" },
          reviewerAgentUuid: "reviewer-current",
          requesterGithubLogin: "writer",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const sdk = new FirstTreeHubSDK({
      serverUrl: SERVER_URL,
      getAccessToken: async () => "member-access-token",
    });

    await expect(
      sdk.preflightMemberContextTreeWrite("team-a", { requesterGithubLogin: "writer" }, { retry: false }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
