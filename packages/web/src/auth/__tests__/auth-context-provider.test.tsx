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
}));

vi.mock("../../api/auth.js", () => ({
  login: loginMock,
}));

vi.mock("../../api/onboarding-events.js", () => ({
  markOnboardingCompleted: onboardingCompletedMock,
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
  },
  {
    id: "member-2",
    organizationId: "org-2",
    organizationName: "Other",
    role: "member",
    agentId: "human-agent-2",
    orgHasOtherMembers: false,
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
    localStorage.setItem("first-tree:selectedOrganizationId", "org-2");
    apiMocks.getStoredTokens.mockReturnValue({ accessToken: "access", refreshToken: "refresh" });

    await renderAuth();

    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenCalledWith("org-2");
    expect(latestAuth?.meLoaded).toBe(true);
    expect(latestAuth?.currentMembership?.organizationId).toBe("org-2");
    expect(latestAuth?.role).toBe("member");
    expect(flagsMocks.clearOnboardingJoinPath).toHaveBeenCalled();
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
    expect(localStorage.getItem("first-tree:selectedOrganizationId")).toBe("org-2");
    expect(apiMocks.setApiSelectedOrganizationId).toHaveBeenCalledWith("org-2");

    await act(async () => {
      window.dispatchEvent(new CustomEvent("auth:logout"));
    });
    expect(apiMocks.clearStoredTokens).toHaveBeenCalled();
    expect(flagsMocks.clearOnboardingSessionFlags).toHaveBeenCalled();
    expect(latestAuth?.isAuthenticated).toBe(false);
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
