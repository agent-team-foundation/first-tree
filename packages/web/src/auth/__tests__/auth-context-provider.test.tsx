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
const trackEventMock = vi.hoisted(() => vi.fn());
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

vi.mock("../../analytics.js", () => ({
  trackEvent: trackEventMock,
}));

vi.mock("../../utils/onboarding-flags.js", () => flagsMocks);

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

  it("keeps the token-derived scope when /me is temporarily unavailable so logout purges it", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    apiMocks.apiGet.mockRejectedValueOnce(new Error("offline"));

    await renderAuth();
    const storageScope = await import("../../lib/browser-storage-scope.js");
    const departingScope = storageScope.captureBrowserStorageScope();
    const draftKey = storageScope.scopedStorageKey("first-tree:chat-drafts:v1", departingScope);
    localStorage.setItem(draftKey, "secret");
    expect(departingScope.userId).toBe("user-1");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("auth:logout"));
    });

    expect(localStorage.getItem(draftKey)).toBeNull();
    expect(latestAuth?.isAuthenticated).toBe(false);
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
    expect(latestAuth?.isAuthenticated).toBe(false);
  });

  it("invalidates the active account when another tab publishes a storage-scope logout", async () => {
    apiMocks.getStoredTokens.mockReturnValue({
      accessToken: tokenWithPayload({ sub: "user-1" }),
      refreshToken: "refresh",
    });
    await renderAuth();
    const scope = await import("../../lib/browser-storage-scope.js");
    const account = scope.captureBrowserStorageScope();

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "first-tree:invalidated-scopes:v1",
          newValue: JSON.stringify([account.key]),
        }),
      );
      await Promise.resolve();
    });
    await flush();

    expect(latestAuth?.isAuthenticated).toBe(false);
    expect(scope.isBrowserStorageScopeCurrent(account)).toBe(false);
  });

  it("clears persisted browser data on logout before a returning sign-in", async () => {
    // /me's default (most-recent) is org-1, but the user last used org-2.
    localStorage.setItem("first-tree:selectedOrganizationId:user-1", "org-2");
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });

    await renderAuth();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    const storageScope = await import("../../lib/browser-storage-scope.js");
    const departingScope = storageScope.captureBrowserStorageScope();
    const draftKey = storageScope.scopedStorageKey("first-tree:chat-drafts:v1", departingScope);
    localStorage.setItem(draftKey, JSON.stringify({ draft: "secret" }));
    localStorage.setItem("other-app:key", "keep");

    // Logout clears the departing account's browser-local data; a returning
    // sign-in starts from the server's current default rather than stale state.
    await act(async () => {
      window.dispatchEvent(new CustomEvent("auth:logout"));
    });
    expect(latestAuth?.isAuthenticated).toBe(false);
    expect(localStorage.getItem("first-tree:selectedOrganizationId:user-1")).toBeNull();
    expect(localStorage.getItem(draftKey)).toBeNull();
    expect(localStorage.getItem("other-app:key")).toBe("keep");

    // Returning sign-in uses the server default org-1.
    apiMocks.setApiSelectedOrganizationId.mockClear();
    await act(async () => {
      await latestAuth?.adoptTokens({ accessToken: "access-2", refreshToken: "refresh-2" });
    });
    await flush();
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-1");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenLastCalledWith("org-1");
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

  it("fires the sign_up conversion exactly once when a fresh user first completes onboarding", async () => {
    // Authenticated fresh signup: stored tokens present so fetchMe runs and
    // populates memberships, and /me reports onboarding not yet completed in
    // any membership.
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "a", refreshToken: "r" });
    apiMocks.apiGet.mockResolvedValue({
      user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships: MEMBERSHIPS, // both fixtures carry onboardingCompletedAt: null
      defaultOrganizationId: "org-1",
      onboarding: { step: "create_agent", dismissedAt: null, completedAt: null },
    });
    await renderAuth();

    await act(async () => {
      await latestAuth?.markOnboardingCompleted();
    });
    expect(trackEventMock).toHaveBeenCalledWith("sign_up");
    expect(trackEventMock.mock.calls.filter(([name]) => name === "sign_up")).toHaveLength(1);

    // A second completion (e.g. a stray re-trigger) does not re-fire: the
    // optimistic patch has now stamped the membership, so the account-level
    // "never completed anywhere" guard is false.
    trackEventMock.mockClear();
    await act(async () => {
      await latestAuth?.markOnboardingCompleted();
    });
    expect(trackEventMock).not.toHaveBeenCalledWith("sign_up");
  });

  it("does NOT fire sign_up when a returning user completes onboarding in a second org", async () => {
    // Account-level conversion: this user already finished onboarding in org-1
    // (membership stamp set), and is now completing in a freshly-joined org-2.
    // Joining a second team is not a new signup, so sign_up must not re-fire.
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "a", refreshToken: "r" });
    apiMocks.apiGet.mockResolvedValue({
      user: { id: "user-1", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships: [
        { ...MEMBERSHIPS[0], onboardingCompletedAt: "2026-05-01T00:00:00.000Z" },
        { ...MEMBERSHIPS[1], onboardingCompletedAt: null },
      ],
      defaultOrganizationId: "org-2",
      onboarding: { step: "create_agent", dismissedAt: null, completedAt: null },
    });
    await renderAuth();

    await act(async () => {
      await latestAuth?.markOnboardingCompleted();
    });
    expect(onboardingCompletedMock).toHaveBeenCalled();
    expect(trackEventMock).not.toHaveBeenCalledWith("sign_up");
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
});
