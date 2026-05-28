import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

type UnknownFn = (...args: unknown[]) => unknown;
type ProviderComponent = (props: { children: ReactNode }) => unknown;
type ElementLike = {
  type: unknown;
  props: Record<string, unknown>;
};

const Fragment = Symbol.for("first-tree.auth-test.fragment");

const loginApiMock = vi.fn<() => Promise<{ accessToken: string; refreshToken: string }>>();
const apiGetMock = vi.fn<() => Promise<Record<string, unknown>>>();
const apiPatchMock = vi.fn<() => Promise<Record<string, unknown>>>();
const clearStoredTokensMock = vi.fn();
const getStoredTokensMock = vi.fn<() => unknown>();
const setApiSelectedOrganizationIdMock = vi.fn();
const setStoredTokensMock = vi.fn();
const postOnboardingCompletedMock = vi.fn<() => Promise<void>>();
const clearOnboardingJoinPathMock = vi.fn();
const clearOnboardingSessionFlagsMock = vi.fn();
const queryClientClearMock = vi.fn();

let contextValue: Record<string, unknown> | null = null;
let stateCursor = 0;
let stateSlots: unknown[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownFn(value: unknown): value is UnknownFn {
  return typeof value === "function";
}

function isElementLike(value: unknown): value is ElementLike {
  return isRecord(value) && "type" in value && isRecord(value.props);
}

function createElement(type: unknown, props: Record<string, unknown> | null = null): ElementLike {
  return { type, props: props ?? {} };
}

function renderNode(node: unknown): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) renderNode(child);
    return;
  }
  if (!isElementLike(node)) return;
  if (node.type === Fragment) {
    renderNode(node.props.children);
    return;
  }
  if (isUnknownFn(node.type)) {
    renderNode(node.type(node.props));
    return;
  }
  renderNode(node.props.children);
}

function mockReact(): Record<string, unknown> {
  const react = {
    Fragment,
    createContext: (defaultValue: unknown) => {
      const context = { current: defaultValue };
      const Provider = ({ value, children }: Record<string, unknown>): unknown => {
        context.current = value;
        if (isRecord(value)) contextValue = value;
        return children;
      };
      return { ...context, Provider };
    },
    createElement,
    useCallback: (fn: UnknownFn) => fn,
    useContext: (context: unknown) => (isRecord(context) ? context.current : null),
    useEffect: (fn: UnknownFn) => {
      fn();
    },
    useMemo: (fn: UnknownFn) => fn(),
    useRef: (initial: unknown) => ({ current: initial }),
    useState: (initial: unknown) => {
      const index = stateCursor;
      stateCursor += 1;
      if (!(index in stateSlots)) {
        stateSlots[index] = isUnknownFn(initial) ? initial() : initial;
      }
      const setState = (next: unknown): void => {
        const previous = stateSlots[index];
        stateSlots[index] = isUnknownFn(next) ? next(previous) : next;
      };
      return [stateSlots[index], setState];
    },
  };
  return { ...react, default: react };
}

function setupBrowserStorage(initialSelectedOrg: string | null): void {
  const storage = new Map<string, string>();
  if (initialSelectedOrg) storage.set("first-tree:selectedOrganizationId", initialSelectedOrg);
  const storageApi = {
    clear: () => storage.clear(),
    getItem: (key: string) => storage.get(key) ?? null,
    removeItem: (key: string) => storage.delete(key),
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  vi.stubGlobal("localStorage", storageApi);
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

async function loadProvider(): Promise<ProviderComponent> {
  vi.doMock("react", () => mockReact());
  vi.doMock("react/jsx-runtime", () => ({ Fragment, jsx: createElement, jsxs: createElement }));
  vi.doMock("react/jsx-dev-runtime", () => ({ Fragment, jsxDEV: createElement }));
  vi.doMock("@tanstack/react-query", () => ({
    useQueryClient: () => ({ clear: queryClientClearMock }),
  }));
  vi.doMock("../../api/auth.js", () => ({
    login: loginApiMock,
  }));
  vi.doMock("../../api/client.js", () => ({
    api: {
      get: apiGetMock,
      patch: apiPatchMock,
    },
    clearStoredTokens: clearStoredTokensMock,
    getStoredTokens: getStoredTokensMock,
    setApiSelectedOrganizationId: setApiSelectedOrganizationIdMock,
    setStoredTokens: setStoredTokensMock,
  }));
  vi.doMock("../../api/onboarding-events.js", () => ({
    markOnboardingCompleted: postOnboardingCompletedMock,
  }));
  vi.doMock("../../utils/onboarding-flags.js", () => ({
    clearOnboardingJoinPath: clearOnboardingJoinPathMock,
    clearOnboardingSessionFlags: clearOnboardingSessionFlagsMock,
  }));

  return (await import("../auth-context.js")).AuthProvider;
}

function renderProvider(AuthProvider: ProviderComponent): Record<string, unknown> {
  stateCursor = 0;
  contextValue = null;
  renderNode(createElement(AuthProvider, { children: createElement("span", {}) }));
  if (!contextValue) throw new Error("AuthProvider did not publish a context value");
  return contextValue;
}

const meResponse = {
  user: {
    id: "user-1",
    username: "ada",
    displayName: "Ada Lovelace",
    avatarUrl: null,
  },
  defaultOrganizationId: "org-2",
  memberships: [
    {
      id: "member-1",
      organizationId: "org-1",
      organizationName: "Compute",
      role: "admin",
      agentId: "agent-human",
      orgHasOtherMembers: true,
      status: "active",
    },
    {
      id: "member-2",
      organizationId: "org-2",
      organizationName: "Research",
      role: "member",
      agentId: "agent-research",
      orgHasOtherMembers: false,
      status: "active",
    },
  ],
  onboarding: {
    step: "completed",
    dismissedAt: "2026-05-01T00:00:00.000Z",
    completedAt: "2026-05-02T00:00:00.000Z",
  },
};

describe("AuthProvider", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    stateCursor = 0;
    stateSlots = [];
    contextValue = null;
    setupBrowserStorage("org-1");
    getStoredTokensMock.mockReturnValue(null);
    loginApiMock.mockResolvedValue({ accessToken: "access", refreshToken: "refresh" });
    apiGetMock.mockResolvedValue(meResponse);
    apiPatchMock.mockResolvedValue({ dismissedAt: "2026-05-03T00:00:00.000Z" });
    postOnboardingCompletedMock.mockResolvedValue();
  });

  it("adopts credentials, reconciles /me state, switches orgs, and logs out", async () => {
    const AuthProvider = await loadProvider();

    let auth = renderProvider(AuthProvider);
    expect(auth.isAuthenticated).toBe(false);
    expect(setApiSelectedOrganizationIdMock).toHaveBeenCalledWith("org-1");

    await (auth.login as (username: string, password: string) => Promise<void>)("ada", "secret");
    expect(loginApiMock).toHaveBeenCalledWith("ada", "secret");
    expect(setStoredTokensMock).toHaveBeenCalledWith({ accessToken: "access", refreshToken: "refresh" });
    expect(clearOnboardingJoinPathMock).toHaveBeenCalledTimes(1);

    auth = renderProvider(AuthProvider);
    expect(auth.isAuthenticated).toBe(true);
    expect(auth.organizationId).toBe("org-1");
    expect(auth.memberId).toBe("member-1");
    expect(auth.role).toBe("admin");
    expect(auth.agentId).toBe("agent-human");
    expect(auth.teamDisplayName).toBe("Compute");
    expect(auth.orgHasOtherMembers).toBe(true);
    expect(auth.onboardingStep).toBe("completed");
    expect(auth.meLoaded).toBe(true);

    await (auth.selectOrganization as (organizationId: string) => Promise<void>)("org-2");
    expect(queryClientClearMock).toHaveBeenCalledTimes(1);
    expect(setApiSelectedOrganizationIdMock).toHaveBeenLastCalledWith("org-2");

    await (auth.dismissOnboarding as () => Promise<void>)();
    expect(apiPatchMock).toHaveBeenCalledWith("/me/onboarding", { dismissed: true });

    await (auth.restoreOnboarding as () => Promise<void>)();
    expect(apiPatchMock).toHaveBeenCalledWith("/me/onboarding", { dismissed: false });

    await (auth.markOnboardingCompleted as () => Promise<void>)();
    expect(postOnboardingCompletedMock).toHaveBeenCalledTimes(1);

    await (auth.adoptTokens as (tokens: { accessToken: string; refreshToken: string }) => Promise<void>)({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
    });
    expect(setStoredTokensMock).toHaveBeenCalledWith({ accessToken: "oauth-access", refreshToken: "oauth-refresh" });

    (auth.logout as () => void)();
    expect(clearStoredTokensMock).toHaveBeenCalledTimes(1);
    expect(clearOnboardingSessionFlagsMock).toHaveBeenCalledTimes(1);
    expect(setApiSelectedOrganizationIdMock).toHaveBeenLastCalledWith(null);
  });

  it("keeps route guards moving when /me fails", async () => {
    getStoredTokensMock.mockReturnValue({ accessToken: "existing" });
    apiGetMock.mockRejectedValueOnce(new Error("offline"));
    const AuthProvider = await loadProvider();

    const auth = renderProvider(AuthProvider);

    expect(auth.isAuthenticated).toBe(true);
    expect(auth.meLoaded).toBe(false);
    await (auth.refreshMe as () => Promise<void>)();
    renderProvider(AuthProvider);
    expect(apiGetMock).toHaveBeenCalledWith("/me");
  });
});
