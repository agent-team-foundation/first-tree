// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { createCandidateTokenSnapshot } from "../../auth/session/candidate-tokens.js";
import { createSessionAttempt } from "../../auth/session/types.js";
import { CandidateApiError, requestCandidateMe } from "../candidate-client.js";

function base64Url(value: string): string {
  return btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function token(type: "access" | "refresh", sub = "account-a"): string {
  return `${base64Url("header")}.${base64Url(JSON.stringify({ sub, type, exp: 2_000_000_000 }))}.signature`;
}

function candidate(sub = "account-a") {
  return createCandidateTokenSnapshot({ accessToken: token("access", sub), refreshToken: token("refresh", sub) });
}

function attempt() {
  const value = createSessionAttempt({
    attemptId: "attempt-a",
    kind: "acquisition",
    serverAuthority: "https://s1.example/api/v1",
    baselineGeneration: "generation-a",
    sourceEpoch: null,
    expiresAt: Date.now() + 60_000,
    payload: { ownerTabId: "tab-a", returnTabId: "tab-return" },
  });
  if (value.kind !== "acquisition") throw new Error("expected acquisition attempt fixture");
  return value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("candidate client", () => {
  it("uses only the explicit candidate bearer and both dispatch/delivery fences", async () => {
    const events: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      events.push("fetch");
      expect(init).toMatchObject({
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token("access")}`);
      expect(new Headers(init?.headers).get("x-first-tree-expected-authority")).toBe("https://s1.example/api/v1");
      return jsonResponse({ user: { id: "account-a", displayName: "A" }, memberships: [] });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await requestCandidateMe({
      candidate: candidate(),
      attempt: attempt(),
      serverAuthority: "https://s1.example/api/v1",
      signal: new AbortController().signal,
      dispatch: async (start) => {
        events.push("admit");
        const response = start();
        events.push("dispatched");
        return response;
      },
      assertResponseCurrent: async () => {
        events.push("response-gate");
      },
    });

    expect(events).toEqual(["admit", "fetch", "dispatched", "response-gate"]);
    expect(result.accountId).toBe("account-a");
  });

  it("rejects a server-verified identity that differs from the decoded candidate subject", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ user: { id: "account-b" } })),
    );
    await expect(
      requestCandidateMe({
        candidate: candidate("account-a"),
        attempt: attempt(),
        serverAuthority: "https://s1.example/api/v1",
        signal: new AbortController().signal,
        dispatch: (start) => start(),
        assertResponseCurrent: async () => undefined,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a caller-supplied fingerprint that does not match the exact token bytes", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestCandidateMe({
        candidate: { ...candidate(), credentialFingerprint: "mismatched-fingerprint" },
        attempt: attempt(),
        serverAuthority: "https://s1.example/api/v1",
        signal: new AbortController().signal,
        dispatch: (start) => start(),
        assertResponseCurrent: async () => undefined,
      }),
    ).rejects.toEqual(new CandidateApiError(400, "Candidate fingerprint does not match its token bytes"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a late response when the post-response authority fence fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ user: { id: "account-a" } })),
    );
    const stale = new Error("stale lease");
    await expect(
      requestCandidateMe({
        candidate: candidate(),
        attempt: attempt(),
        serverAuthority: "https://s1.example/api/v1",
        signal: new AbortController().signal,
        dispatch: (start) => start(),
        assertResponseCurrent: async () => {
          throw stale;
        },
      }),
    ).rejects.toBe(stale);
  });

  it("rechecks authority and replaces unknown network errors with a fixed safe error", async () => {
    const gate = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("GET https://secret.example/invite/capability failed");
      }),
    );

    const failure = await requestCandidateMe({
      candidate: candidate(),
      attempt: attempt(),
      serverAuthority: "https://s1.example/api/v1",
      signal: new AbortController().signal,
      dispatch: (start) => start(),
      assertResponseCurrent: gate,
    }).catch((error: unknown) => error);

    expect(gate).toHaveBeenCalledTimes(1);
    expect(failure).toEqual(new CandidateApiError(503, "Candidate identity request is unavailable"));
    expect(String((failure as Error).message)).not.toContain("secret.example");
    expect(String((failure as Error).stack)).not.toContain("secret.example");
  });

  it("does not refresh, persist, or dispatch logout for a candidate 401", async () => {
    const logout = vi.fn();
    window.addEventListener("auth:logout", logout);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "Unauthorized" }, 401)),
    );
    try {
      await expect(
        requestCandidateMe({
          candidate: candidate(),
          attempt: attempt(),
          serverAuthority: "https://s1.example/api/v1",
          signal: new AbortController().signal,
          dispatch: (start) => start(),
          assertResponseCurrent: async () => undefined,
        }),
      ).rejects.toEqual(new CandidateApiError(401, "Candidate identity request failed (401)"));
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(logout).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("auth:logout", logout);
    }
  });

  it("fails closed for malformed, wrong-content-type, and oversized responses", async () => {
    const input = {
      candidate: candidate(),
      attempt: attempt(),
      serverAuthority: "https://s1.example/api/v1",
      signal: new AbortController().signal,
      dispatch: (start: () => Promise<Response>) => start(),
      assertResponseCurrent: async () => undefined,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { headers: { "Content-Type": "text/plain" } })),
    );
    await expect(requestCandidateMe(input)).rejects.toMatchObject({ status: 502 });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "999999" } }),
      ),
    );
    await expect(requestCandidateMe(input)).rejects.toMatchObject({ status: 502 });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ user: null })),
    );
    await expect(requestCandidateMe(input)).rejects.toMatchObject({ status: 502 });
  });
});
