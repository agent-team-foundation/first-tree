// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

beforeEach(() => {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

function response(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api client request flow", () => {
  it("stores tokens, sends auth headers, and parses 204 responses", async () => {
    const { api, clearStoredTokens, getStoredTokens, setStoredTokens } = await import("../client.js");
    setStoredTokens({ accessToken: "access-1", refreshToken: "refresh-1" });
    expect(getStoredTokens()).toEqual({ accessToken: "access-1", refreshToken: "refresh-1" });

    fetchMock
      .mockResolvedValueOnce(response(200, { ok: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(api.get<{ ok: true }>("/me")).resolves.toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer access-1" },
    });

    await expect(api.delete<void>("/clients/client-1")).resolves.toBeUndefined();
    clearStoredTokens();
    expect(getStoredTokens()).toBeNull();
  });

  it("refreshes on 401 and retries with the new access token", async () => {
    const { api, getStoredTokens, setStoredTokens } = await import("../client.js");
    setStoredTokens({ accessToken: "expired", refreshToken: "refresh-1" });
    fetchMock
      .mockResolvedValueOnce(response(401, { error: "expired" }))
      .mockResolvedValueOnce(response(200, { accessToken: "access-2", refreshToken: "refresh-2" }))
      .mockResolvedValueOnce(response(200, { ok: true }));

    await expect(api.get<{ ok: true }>("/me")).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/auth/refresh");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer access-2" },
    });
    expect(getStoredTokens()).toEqual({ accessToken: "access-2", refreshToken: "refresh-2" });
  });

  it("does not resurrect an old account when refresh resolves after logout", async () => {
    const { api, clearStoredTokens, getStoredTokens, setStoredTokens } = await import("../client.js");
    setStoredTokens({ accessToken: "a-expired", refreshToken: "a-refresh" });
    let resolveRefresh!: (value: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    fetchMock.mockResolvedValueOnce(response(401, { error: "expired" })).mockReturnValueOnce(refreshResponse);

    const pending = api.get("/me");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    clearStoredTokens();
    setStoredTokens({ accessToken: "b-access", refreshToken: "b-refresh" });
    resolveRefresh(response(200, { accessToken: "a-new", refreshToken: "a-new-refresh" }));

    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(getStoredTokens()).toEqual({ accessToken: "b-access", refreshToken: "b-refresh" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws ApiError with validation issues and dispatches auth logout on unrecovered 401", async () => {
    const { api, getStoredTokens, setStoredTokens } = await import("../client.js");
    setStoredTokens({ accessToken: "bad", refreshToken: "refresh-bad" });
    const logout = vi.fn();
    window.addEventListener("auth:logout", logout);
    fetchMock
      .mockResolvedValueOnce(response(400, { error: "Invalid", details: [{ path: ["name"], message: "Required" }] }))
      .mockResolvedValueOnce(response(401, { error: "expired" }))
      .mockResolvedValueOnce(response(500, { error: "refresh failed" }));

    await expect(api.post("/agents", { name: "" })).rejects.toMatchObject({
      status: 400,
      message: "Invalid",
      issues: [{ path: ["name"], message: "Required" }],
    });
    await expect(api.get("/me")).rejects.toMatchObject({ status: 401 });
    expect(logout).toHaveBeenCalled();
    expect(getStoredTokens()).toBeNull();
  });

  it("formats org paths and handles malformed stored token JSON", async () => {
    const { getStoredTokens, setApiSelectedOrganizationId, withOrg, withOrgAt } = await import("../client.js");
    localStorage.setItem("first-tree:tokens", "{bad");
    expect(getStoredTokens()).toBeNull();

    setApiSelectedOrganizationId("org/with space");
    expect(withOrg("/agents?limit=1")).toBe("/orgs/org%2Fwith%20space/agents?limit=1");
    expect(withOrgAt("other/org", "/members")).toBe("/orgs/other%2Forg/members");
    setApiSelectedOrganizationId(null);
    expect(() => withOrg("/agents")).toThrow(/before an organization is selected/);
  });

  it("surfaces plain request errors and direct refresh failures", async () => {
    const { api, refreshAccessToken, setStoredTokens } = await import("../client.js");

    await expect(refreshAccessToken()).resolves.toBeNull();

    setStoredTokens({ accessToken: "access-1", refreshToken: "refresh-1" });
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(refreshAccessToken()).resolves.toBeNull();

    fetchMock.mockResolvedValueOnce(new Response("plain failure", { status: 500 }));
    await expect(api.get("/plain-error")).rejects.toMatchObject({ status: 500, message: "plain failure" });
  });

  it("fetches raw payloads with refresh retry and fallback refresh token persistence", async () => {
    const { apiFetchRaw, getStoredTokens, setStoredTokens } = await import("../client.js");
    setStoredTokens({ accessToken: "expired", refreshToken: "refresh-1" });
    fetchMock
      .mockResolvedValueOnce(response(401, { error: "expired" }))
      .mockResolvedValueOnce(response(200, { accessToken: "access-2" }))
      .mockResolvedValueOnce(new Response("raw ok", { status: 200 }));

    const res = await apiFetchRaw("/attachments/image-1", {
      method: "PUT",
      body: "raw-body",
      headers: { "Content-Type": "text/plain" },
    });

    await expect(res.text()).resolves.toBe("raw ok");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      headers: { Authorization: "Bearer expired", "Content-Type": "text/plain" },
      body: "raw-body",
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/v1/auth/refresh");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "PUT",
      headers: { Authorization: "Bearer access-2", "Content-Type": "text/plain" },
      body: "raw-body",
    });
    expect(getStoredTokens()).toEqual({ accessToken: "access-2", refreshToken: "refresh-1" });
  });

  it("reports raw fetch errors and clears auth state on unrecovered raw 401", async () => {
    const { apiFetchRaw, getStoredTokens, setStoredTokens } = await import("../client.js");

    fetchMock.mockResolvedValueOnce(response(503, { error: "raw failed" }));
    await expect(apiFetchRaw("/raw-json-error")).rejects.toMatchObject({ status: 503, message: "raw failed" });

    fetchMock.mockResolvedValueOnce(new Response("raw text failed", { status: 500 }));
    await expect(apiFetchRaw("/raw-text-error")).rejects.toMatchObject({ status: 500, message: "raw text failed" });

    setStoredTokens({ accessToken: "bad", refreshToken: "" });
    const logout = vi.fn();
    window.addEventListener("auth:logout", logout);
    fetchMock.mockResolvedValueOnce(response(401, { error: "raw unauthorized" }));

    await expect(apiFetchRaw("/raw-unauthorized")).rejects.toMatchObject({
      status: 401,
      message: "raw unauthorized",
    });
    expect(logout).toHaveBeenCalled();
    expect(getStoredTokens()).toBeNull();
  });
});
