// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const apiMocks = vi.hoisted(() => ({
  clearStoredTokens: vi.fn(),
  getStoredTokens: vi.fn(),
  setApiSelectedOrganizationId: vi.fn(),
  setStoredTokens: vi.fn(),
  apiGet: vi.fn(),
  apiPatch: vi.fn(),
}));

const loginMock = vi.hoisted(() => vi.fn());
const onboardingCompletedMock = vi.hoisted(() => vi.fn());
const purgeLocalUserDataMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const flagsMocks = vi.hoisted(() => ({
  clearOnboardingJoinPath: vi.fn(),
  clearOnboardingSessionFlags: vi.fn(),
}));

vi.mock("../../api/client.js", () => ({
  api: {
    get: apiMocks.apiGet,
    patch: apiMocks.apiPatch,
  },
  clearStoredTokens: apiMocks.clearStoredTokens,
  getStoredTokens: apiMocks.getStoredTokens,
  setApiSelectedOrganizationId: apiMocks.setApiSelectedOrganizationId,
  setStoredTokens: apiMocks.setStoredTokens,
  ADMIN_WS_ORG_CHANGED_EVENT: "admin-ws:org-changed",
}));

vi.mock("../../api/auth.js", () => ({
  login: loginMock,
}));

vi.mock("../../api/onboarding-events.js", () => ({
  markOnboardingCompleted: onboardingCompletedMock,
}));

vi.mock("../../utils/onboarding-flags.js", () => flagsMocks);

vi.mock("../../lib/purge-local-data.js", () => ({
  purgeLocalUserData: purgeLocalUserDataMock,
}));

let root: Root | null = null;
let container: HTMLElement | null = null;
let latestAuth: ReturnType<typeof import("../auth-context.js").useAuth> | null = null;

const MEMBERSHIPS: MeMembership[] = [
  {
    id: "member-1",
    organizationId: "org-1",
    organizationName: "Acme",
    role: "admin",
    agentId: "human-agent-1",
    orgHasOtherMembers: true,
    hasUsableAgent: true,
    hasPersonalAgent: true,
    onboardingSuppressedAt: null,
    onboardingSuppressedReason: null,
    onboardingCompletedAt: null,
  },
  {
    id: "member-2",
    organizationId: "org-2",
    organizationName: "Other",
    role: "member",
    agentId: "human-agent-2",
    orgHasOtherMembers: false,
    hasUsableAgent: false,
    hasPersonalAgent: false,
    onboardingSuppressedAt: null,
    onboardingSuppressedReason: null,
    onboardingCompletedAt: null,
  },
];

function setupDom(): void {
  const storage = createStorage();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: createStorage() });
}

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

function tokenWithPayload(payload: unknown): string {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `header.${encoded}.signature`;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAuth(children?: ReactNode): Promise<void> {
  const { AuthProvider, useAuth } = await import("../auth-context.js");
  function Probe() {
    latestAuth = useAuth();
    return <div data-auth={latestAuth.isAuthenticated ? "yes" : "no"}>{children}</div>;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  setupDom();
  document.body.innerHTML = "";
  latestAuth = null;
  root = null;
  container = null;
  vi.clearAllMocks();
  apiMocks.getStoredTokens.mockReturnValue(null);
  // Realistic token store: adopting/storing tokens makes them readable, so
  // post-adoption requests capture the NEW session's subject — generation
  // and subject guards are then both exercised for real.
  apiMocks.setStoredTokens.mockImplementation((tokens: { accessToken: string; refreshToken: string }) => {
    apiMocks.getStoredTokens.mockReturnValue(tokens);
  });
  apiMocks.apiGet.mockResolvedValue({
    user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
    memberships: MEMBERSHIPS,
    defaultOrganizationId: "org-1",
    onboarding: {
      step: "completed",
      dismissedAt: null,
      completedAt: "2026-05-01T00:00:00.000Z",
    },
  });
  apiMocks.apiPatch.mockResolvedValue({ dismissedAt: "2026-05-28T00:00:00.000Z" });
  loginMock.mockResolvedValue({ accessToken: "access-login", refreshToken: "refresh-login" });
  onboardingCompletedMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  document.body.innerHTML = "";
});

describe("AuthProvider", () => {
  it("loads stored tokens, reconciles organization selection, and exposes current membership", async () => {
    localStorage.setItem("first-tree:selectedOrganizationId:user-1", "org-2");
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });

    await renderAuth();

    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenCalledWith("org-2");
    expect(latestAuth?.meLoaded).toBe(true);
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    expect(latestAuth?.role).toBe("member");
    expect(flagsMocks.clearOnboardingJoinPath).toHaveBeenCalled();
  });

  it("preseeds the selected organization from the stored token subject before /me settles", async () => {
    localStorage.setItem("first-tree:selectedOrganizationId:user-1", "org-2");
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });

    await renderAuth();

    expect(apiMocks.setApiSelectedOrganizationId.mock.calls[0]?.[0]).toBe("org-2");
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
  });

  it("ignores unreadable persisted organization storage and rolls back failed dismiss", async () => {
    const throwingStorage = {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => {
        throw new Error("blocked");
      },
      key: () => null,
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } satisfies Storage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: throwingStorage });
    Object.defineProperty(window, "localStorage", { configurable: true, value: throwingStorage });
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    apiMocks.apiGet.mockResolvedValueOnce({
      user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships: [
        {
          ...MEMBERSHIPS[0],
          onboardingSuppressedAt: "2026-05-01T00:00:00.000Z",
          onboardingSuppressedReason: "finish_later",
        },
      ],
      defaultOrganizationId: "org-1",
      onboarding: { step: "create_agent", dismissedAt: null, completedAt: null },
    });

    await renderAuth();
    apiMocks.apiPatch.mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      await latestAuth?.dismissOnboarding();
    });

    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenCalledWith(null);
    expect(latestAuth?.onboardingDismissedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(latestAuth?.currentMembership?.onboardingSuppressedReason).toBe("finish_later");
  });

  it("does not fall back to another membership's onboarding stamps when selected membership stamps are null", async () => {
    localStorage.setItem("first-tree:selectedOrganizationId:user-1", "org-2");
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });
    apiMocks.apiGet.mockResolvedValueOnce({
      user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships: [
        {
          ...MEMBERSHIPS[0],
          onboardingSuppressedAt: "2026-05-28T00:00:00.000Z",
          onboardingSuppressedReason: "completed",
          onboardingCompletedAt: "2026-05-28T00:00:00.000Z",
        },
        MEMBERSHIPS[1],
      ],
      defaultOrganizationId: "org-1",
      onboarding: {
        step: "create_agent",
        dismissedAt: "2026-05-28T00:00:00.000Z",
        completedAt: "2026-05-28T00:00:00.000Z",
      },
    });

    await renderAuth();

    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    expect(latestAuth?.onboardingDismissedAt).toBeNull();
    expect(latestAuth?.onboardingCompletedAt).toBeNull();
  });

  it("logs in, switches organizations, and clears auth state on logout events", async () => {
    await renderAuth();
    await act(async () => {
      await latestAuth?.login("gandy", "secret");
    });
    await flush();

    expect(loginMock).toHaveBeenCalledWith("gandy", "secret");
    expect(apiMocks.setStoredTokens).toHaveBeenCalledWith({
      accessToken: "access-login",
      refreshToken: "refresh-login",
    });
    expect(latestAuth?.isAuthenticated).toBe(true);

    await act(async () => {
      await latestAuth?.selectOrganization("org-2");
    });
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-2");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenCalledWith("org-2");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("auth:logout"));
    });
    expect(apiMocks.clearStoredTokens).toHaveBeenCalled();
    expect(flagsMocks.clearOnboardingSessionFlags).toHaveBeenCalled();
    // SEC-042: logout must purge locally persisted user content (cached
    // messages, read state, images, drafts) — not just tokens + query cache.
    expect(purgeLocalUserDataMock).toHaveBeenCalled();
    expect(latestAuth?.isAuthenticated).toBe(false);
  });

  it("keeps the persisted org across logout so a returning sign-in lands back in the last-used org", async () => {
    // /me's default (most-recent) is org-1, but the user last used org-2.
    localStorage.setItem("first-tree:selectedOrganizationId:user-1", "org-2");
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });

    await renderAuth();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");

    // Logout must NOT wipe the persisted org — it's how a returning sign-in
    // restores the last-used org instead of jumping to the most-recent one.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("auth:logout"));
    });
    expect(latestAuth?.isAuthenticated).toBe(false);
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-2");

    // Returning sign-in: fetchMe restores org-2, not the server default org-1.
    apiMocks.setApiSelectedOrganizationId.mockClear();
    await act(async () => {
      await latestAuth?.adoptTokens({ accessToken: "access-2", refreshToken: "refresh-2" });
    });
    await flush();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-2");
  });

  it("falls back to the server default when the persisted org is no longer a membership", async () => {
    // Stored org the user has since left → must fall back to /me's default.
    localStorage.setItem("first-tree:selectedOrganizationId:user-1", "org-gone");
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });

    await renderAuth();

    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-1");
  });

  it("does not let a different user on the same browser inherit the previous account's org", async () => {
    // user-1 left org-2 persisted. Now user-2 signs in on the same browser and
    // is ALSO an active member of org-2 — so a global (non-user-scoped) key
    // would leak. The per-user key must isolate them: user-2 lands in the
    // server default, and user-1's stored value is untouched.
    localStorage.setItem("first-tree:selectedOrganizationId:user-1", "org-2");
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });
    apiMocks.apiGet.mockResolvedValueOnce({
      user: { id: "user-2", username: "other", displayName: "Other", avatarUrl: null },
      memberships: MEMBERSHIPS,
      defaultOrganizationId: "org-1",
      onboarding: { step: "completed", dismissedAt: null, completedAt: "2026-05-01T00:00:00.000Z" },
    });

    await renderAuth();

    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-2");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-2")).toBe("org-1");
  });

  it("optimistically dismisses, restores, and completes onboarding with rollback on patch failure", async () => {
    await renderAuth();

    await act(async () => {
      await latestAuth?.dismissOnboarding();
    });
    expect(latestAuth?.onboardingDismissedAt).toBe("2026-05-28T00:00:00.000Z");

    apiMocks.apiPatch.mockRejectedValueOnce(new Error("network"));
    await act(async () => {
      await latestAuth?.restoreOnboarding();
    });
    expect(latestAuth?.onboardingDismissedAt).toBe("2026-05-28T00:00:00.000Z");

    await act(async () => {
      await latestAuth?.markOnboardingCompleted();
    });
    expect(onboardingCompletedMock).toHaveBeenCalled();
    expect(latestAuth?.onboardingCompletedAt).toBeTruthy();
  });

  it("rolls completion state back when the durable completion stamp fails", async () => {
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });
    await renderAuth();
    onboardingCompletedMock.mockRejectedValueOnce(new Error("offline"));

    await expect(
      act(async () => {
        await latestAuth?.markOnboardingCompleted();
      }),
    ).rejects.toThrow("offline");

    expect(latestAuth?.onboardingCompletedAt).toBeNull();
    expect(latestAuth?.onboardingDismissedAt).toBeNull();
    expect(latestAuth?.currentMembership?.onboardingCompletedAt).toBeNull();
    expect(latestAuth?.currentMembership?.onboardingSuppressedAt).toBeNull();
  });

  it("mirrors a successful kickoff stamp locally without a duplicate completion request", async () => {
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });
    await renderAuth();

    act(() => latestAuth?.applyOnboardingKickoffStamp("invitee_skip"));
    expect(latestAuth?.currentMembership?.onboardingSuppressedReason).toBe("invitee_skip");
    expect(latestAuth?.currentMembership?.onboardingCompletedAt).toBeNull();
    expect(onboardingCompletedMock).not.toHaveBeenCalled();

    act(() => latestAuth?.applyOnboardingKickoffStamp("completed"));
    expect(latestAuth?.currentMembership?.onboardingSuppressedReason).toBe("completed");
    expect(latestAuth?.currentMembership?.onboardingCompletedAt).toBeTruthy();
    expect(onboardingCompletedMock).not.toHaveBeenCalled();
  });

  it("adopts external token pairs and falls back when /me fails", async () => {
    apiMocks.apiGet.mockRejectedValueOnce(new Error("offline"));
    await renderAuth();

    await act(async () => {
      await latestAuth?.adoptTokens({ accessToken: "oauth-access", refreshToken: "oauth-refresh" });
    });
    await flush();

    expect(apiMocks.setStoredTokens).toHaveBeenCalledWith({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
    });
    expect(latestAuth?.isAuthenticated).toBe(true);
    expect(latestAuth?.meLoaded).toBe(true);
  });

  it("rejects and rolls back to the confirmed org when the post-switch /me fails, then allows retry", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    // Initial /me settled on the authoritative org-1.
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    // The post-switch /me is a transport failure: the switch must reject and
    // every optimistic write must roll back to org-1.
    apiMocks.apiGet.mockRejectedValueOnce(new Error("offline"));
    // The rejection handler is attached inside act and swallows the error, so
    // act observes the FULLY settled switch (rollback included) instead of
    // rethrowing early, and every state update stays inside the act boundary.
    let switchError: unknown = null;
    await act(async () => {
      await latestAuth?.selectOrganization("org-2").catch((error: unknown) => {
        switchError = error;
      });
    });
    expect(switchError).toBeInstanceOf(Error);
    expect((switchError as Error).message).toBe("offline");

    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-1");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-1");

    // Retry with a healthy /me confirms the target.
    await act(async () => {
      await latestAuth?.selectOrganization("org-2");
    });
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-2");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-2");
  });

  it("keeps initial-load /me failures fail-soft", async () => {
    apiMocks.apiGet.mockRejectedValueOnce(new Error("offline"));
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });

    // renderAuth's initial effect fetch swallows the failure — no rejection,
    // meLoaded still flips so the app shell never hangs.
    await renderAuth();
    expect(latestAuth?.meLoaded).toBe(true);
    expect(latestAuth?.currentMembership).toBeNull();
  });

  it("does not resurrect the old org when the switch fails through a 401 logout", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    // Mirror request()'s final-401: tokens cleared + auth:logout dispatched
    // BEFORE the rejection reaches selectOrganization's rollback path.
    apiMocks.apiGet.mockImplementationOnce(async () => {
      apiMocks.getStoredTokens.mockReturnValue(null);
      window.dispatchEvent(new CustomEvent("auth:logout"));
      throw new Error("unauthorized");
    });
    let switchError: unknown = null;
    await act(async () => {
      await latestAuth?.selectOrganization("org-2").catch((error: unknown) => {
        switchError = error;
      });
    });
    expect(switchError).toBeInstanceOf(Error);

    // Logout owns the final state: authenticated false, no membership/org,
    // and the API override was cleared by logout — the rollback must NOT
    // have written the old org back afterwards.
    expect(latestAuth?.isAuthenticated).toBe(false);
    expect(latestAuth?.currentMembership).toBeNull();
    expect(latestAuth?.organizationId).toBeNull();
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith(null);
  });

  it("discards a successful /me that lands after logout", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    let resolveOldMe!: (value: unknown) => void;
    apiMocks.apiGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldMe = resolve;
        }),
    );
    await renderAuth(); // the initial session's /me stays in flight

    await act(async () => {
      window.dispatchEvent(new CustomEvent("auth:logout"));
    });
    expect(latestAuth?.isAuthenticated).toBe(false);

    // The old request finally SUCCEEDS — it must mutate nothing: no user,
    // no memberships, no org, no API override, and the loading gate stays
    // with the logged-out session.
    await act(async () => {
      resolveOldMe({
        user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
        memberships: MEMBERSHIPS,
        defaultOrganizationId: "org-1",
        onboarding: { step: "completed" },
      });
    });
    await flush();

    expect(latestAuth?.isAuthenticated).toBe(false);
    expect(latestAuth?.user).toBeNull();
    expect(latestAuth?.currentMembership).toBeNull();
    expect(latestAuth?.organizationId).toBeNull();
    expect(latestAuth?.meLoaded).toBe(false);
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith(null);
  });

  it("keeps session B authoritative when an older session's /me lands later", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    let resolveOldMe!: (value: unknown) => void;
    apiMocks.apiGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldMe = resolve;
        }),
    );
    // Session B's /me payload for every later request.
    apiMocks.apiGet.mockResolvedValue({
      user: { id: "user-2", username: "other", displayName: "Other", avatarUrl: null },
      memberships: MEMBERSHIPS,
      defaultOrganizationId: "org-1",
      onboarding: { step: "completed", dismissedAt: null, completedAt: "2026-05-01T00:00:00.000Z" },
    });
    await renderAuth(); // session A's /me stays in flight

    await act(async () => {
      await latestAuth?.adoptTokens({ accessToken: tokenWithPayload({ sub: "user-2" }), refreshToken: "refresh-2" });
    });
    expect(latestAuth?.user?.id).toBe("user-2");

    await act(async () => {
      resolveOldMe({
        user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
        memberships: [],
        defaultOrganizationId: null,
        onboarding: { step: "connect" },
      });
    });
    await flush();

    expect(latestAuth?.user?.id).toBe("user-2");
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
  });

  it("rejects a switch whose /me succeeds only after logout, mutating nothing", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    let resolveSwitchMe!: (value: unknown) => void;
    apiMocks.apiGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSwitchMe = resolve;
        }),
    );
    let switchError: unknown = null;
    await act(async () => {
      const settled = latestAuth?.selectOrganization("org-2").catch((error: unknown) => {
        switchError = error;
      });
      window.dispatchEvent(new CustomEvent("auth:logout"));
      // A SUCCESS arrives, but for the pre-logout session — discarded, and
      // the switch rejects without rolling anything into the logged-out state.
      resolveSwitchMe({
        user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
        memberships: MEMBERSHIPS,
        defaultOrganizationId: "org-1",
        onboarding: { step: "completed" },
      });
      await settled;
    });

    expect(switchError).toBeInstanceOf(Error);
    expect(latestAuth?.isAuthenticated).toBe(false);
    expect(latestAuth?.currentMembership).toBeNull();
    expect(latestAuth?.organizationId).toBeNull();
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith(null);
  });

  it("treats logout plus relogin as the same subject as a new session for stale responses", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    let resolveOldMe!: (value: unknown) => void;
    apiMocks.apiGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOldMe = resolve;
        }),
    );
    await renderAuth(); // old session's /me stays in flight

    await act(async () => {
      window.dispatchEvent(new CustomEvent("auth:logout"));
    });
    // Relogin as the SAME subject — still a new generation; its /me applies.
    await act(async () => {
      await latestAuth?.adoptTokens({ accessToken: tokenWithPayload({ sub: "user-1" }), refreshToken: "refresh-new" });
    });
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    const apiOrgCallsBefore = apiMocks.setApiSelectedOrganizationId.mock.calls.length;
    // The pre-logout response finally lands with poisoned content — it must
    // be discarded even though the subject matches the live session.
    await act(async () => {
      resolveOldMe({
        user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
        memberships: [],
        defaultOrganizationId: null,
        onboarding: { step: "connect" },
      });
    });
    await flush();

    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(latestAuth?.user?.id).toBe("user-1");
    expect(apiMocks.setApiSelectedOrganizationId.mock.calls.length).toBe(apiOrgCallsBefore);
  });

  it("adoptTokens applies its own authoritative /me even when the auth effect starts a second one", async () => {
    // Unauthenticated mount: no initial fetch. Every /me is deferred so we
    // can settle the adopt's awaited request while the effect's same-session
    // second request is still pending.
    const deferred: Array<(value: unknown) => void> = [];
    apiMocks.apiGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(resolve);
        }),
    );
    await renderAuth();

    await act(async () => {
      const adopt = latestAuth?.adoptTokens({
        accessToken: tokenWithPayload({ sub: "user-2" }),
        refreshToken: "refresh-2",
      });
      // Let the adopt's awaited /me start AND the isAuthenticated effect fire
      // its second same-session /me, then settle the awaited one with B's
      // authoritative payload.
      await Promise.resolve();
      deferred[0]?.({
        user: { id: "user-2", username: "other", displayName: "Other", avatarUrl: null },
        memberships: MEMBERSHIPS,
        defaultOrganizationId: "org-1",
        onboarding: { step: "completed" },
      });
      await adopt;
    });

    // The adopt promise returned only after REAL B authority was applied —
    // no bootstrap gap, and the gate came from the live request.
    expect(latestAuth?.user?.id).toBe("user-2");
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(latestAuth?.meLoaded).toBe(true);

    // The effect's second request settles later in the same session — it
    // applies cleanly instead of erroring or tearing B down.
    await act(async () => {
      deferred[1]?.({
        user: { id: "user-2", username: "other", displayName: "Other", avatarUrl: null },
        memberships: MEMBERSHIPS,
        defaultOrganizationId: "org-1",
        onboarding: { step: "completed" },
      });
    });
    expect(latestAuth?.user?.id).toBe("user-2");
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
  });

  it("never rolls back a switch that a concurrent same-session refresh already confirmed", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    const deferred: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
    apiMocks.apiGet.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          deferred.push({ resolve, reject });
        }),
    );
    const mePayload = {
      user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships: MEMBERSHIPS,
      defaultOrganizationId: "org-1",
      onboarding: { step: "completed" },
    };

    let switchError: unknown = null;
    let switchDone = false;
    await act(async () => {
      const settled = latestAuth?.selectOrganization("org-2").then(
        () => {
          switchDone = true;
        },
        (error: unknown) => {
          switchError = error;
        },
      );
      void latestAuth?.refreshMe();
      // The unrelated refresh CONFIRMS org-2 first; the switch's own request
      // then fails. The confirmed snapshot must win — no rollback, no false
      // failure.
      deferred[1]?.resolve(mePayload);
      deferred[0]?.reject(new Error("offline"));
      await settled;
    });

    expect(switchError).toBeNull();
    expect(switchDone).toBe(true);
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-2");
  });

  it("keeps a switch confirmed by its own request when a concurrent refresh settles later", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    const deferred: Array<(value: unknown) => void> = [];
    apiMocks.apiGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          deferred.push(resolve);
        }),
    );
    const mePayload = {
      user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships: MEMBERSHIPS,
      defaultOrganizationId: "org-1",
      onboarding: { step: "completed" },
    };

    let switchDone = false;
    await act(async () => {
      const settled = latestAuth?.selectOrganization("org-2").then(() => {
        switchDone = true;
      });
      void latestAuth?.refreshMe();
      // The switch's own request confirms org-2 first; the refresh settles
      // afterwards with the same authoritative snapshot.
      deferred[0]?.(mePayload);
      deferred[1]?.(mePayload);
      await settled;
    });

    expect(switchDone).toBe(true);
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-2");
  });

  it("rejects a failed re-confirmation of the already-current org instead of faking success", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    // A is already the confirmed org — but a NEW failed /me must not borrow
    // that old confirmation to succeed.
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    apiMocks.apiGet.mockRejectedValueOnce(new Error("offline"));
    let switchError: unknown = null;
    await act(async () => {
      await latestAuth?.selectOrganization("org-1").catch((error: unknown) => {
        switchError = error;
      });
    });

    expect(switchError).toBeInstanceOf(Error);
    expect((switchError as Error).message).toBe("offline");
    // The ordinary rollback keeps every surface on the confirmed org A.
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-1");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-1");
  });

  it("exposes /me authority separately from the fail-soft loaded gate", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    apiMocks.apiGet.mockRejectedValueOnce(new Error("offline"));
    await renderAuth();

    // Initial transport failure: fail-soft shell opens, but no authoritative
    // snapshot exists — meLoaded true, authority false.
    expect(latestAuth?.meLoaded).toBe(true);
    expect(latestAuth?.meAuthoritative).toBe(false);
    expect(latestAuth?.currentMembership).toBeNull();

    // A successful retry establishes authority with the exact memberships/org.
    await act(async () => {
      await latestAuth?.refreshMe();
    });
    expect(latestAuth?.meAuthoritative).toBe(true);
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
  });

  it("rejects a switch satisfied only by a refresh begun before the attempt", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");

    const deferred: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }> = [];
    apiMocks.apiGet.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          deferred.push({ resolve, reject });
        }),
    );
    const mePayload = {
      user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships: MEMBERSHIPS,
      defaultOrganizationId: "org-1",
      onboarding: { step: "completed" },
    };

    let switchError: unknown = null;
    await act(async () => {
      // A refresh that BEGAN before the switch attempt.
      void latestAuth?.refreshMe();
      await Promise.resolve();
      const settled = latestAuth?.selectOrganization("org-2").catch((error: unknown) => {
        switchError = error;
      });
      // The pre-attempt refresh resolves first and happens to settle the
      // mutable target; the switch-owned request then fails. The pre-attempt
      // request must NOT satisfy this switch.
      deferred[0]?.resolve(mePayload);
      deferred[1]?.reject(new Error("offline"));
      await settled;
    });

    expect(switchError).toBeInstanceOf(Error);
    // Full rollback to the prior confirmed Team — no borrowed authority.
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-1");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-1");

    // The hidden rollback baseline must also be A: a SECOND failed switch
    // (no confirming request at all) must roll back to A again — never to
    // the pre-attempt refresh's incidentally settled B.
    apiMocks.apiGet.mockRejectedValueOnce(new Error("offline"));
    let secondError: unknown = null;
    await act(async () => {
      await latestAuth?.selectOrganization("org-2").catch((error: unknown) => {
        secondError = error;
      });
    });
    expect(secondError).toBeInstanceOf(Error);
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBe("org-1");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-1");
  });
});
