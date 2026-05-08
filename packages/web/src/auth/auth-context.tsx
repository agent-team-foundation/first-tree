import type { MeMembership } from "@agent-team-foundation/first-tree-hub-shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import {
  api,
  clearStoredTokens,
  getStoredTokens,
  setApiSelectedOrganizationId,
  setStoredTokens,
} from "../api/client.js";
import { clearOnboardingJoinPath } from "../utils/onboarding-flags.js";

type MeUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

type MeResponse = {
  user?: MeUser;
  defaultOrganizationId?: string | null;
  memberships?: MeMembership[];
  onboarding?: {
    step: "connect" | "create_agent" | "completed";
    /** ISO timestamp when the user dismissed the onboarding stepper, else null. */
    dismissedAt?: string | null;
  };
};

type AuthContextValue = {
  isAuthenticated: boolean;
  /**
   * `true` once `/me` has resolved at least once (success or failure) since
   * the last login. Route guards block rendering authenticated children
   * until this flips — otherwise pages mount and fire React-Query requests
   * before `setApiSelectedOrganizationId` is called, and any org-scoped
   * call that goes through `withOrg` throws.
   */
  meLoaded: boolean;
  user: MeUser | null;
  memberships: MeMembership[];
  /**
   * Currently selected membership — drives `organizationId / memberId / role
   * / agentId` and the admin gate. Initialized from
   * `localStorage.selectedOrganizationId`; falls back to the first active
   * membership returned by `/me`.
   */
  currentMembership: MeMembership | null;
  organizationId: string | null;
  memberId: string | null;
  role: string | null;
  agentId: string | null;
  onboardingStep: "connect" | "create_agent" | "completed" | null;
  /**
   * ISO timestamp when the user clicked `✕` on the onboarding stepper.
   * Decoupled from `onboardingStep` (see docs/new-user-onboarding-design.md
   * §8) — `null` means the stepper should render.
   */
  onboardingDismissedAt: string | null;
  /**
   * PATCH `/me/onboarding { dismissed: true }`. Optimistically flips
   * `onboardingDismissedAt` so the stepper unmounts immediately.
   */
  dismissOnboarding: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  /**
   * Adopt a token pair handed in from a non-login surface (OAuth fragment
   * consumer, accept-invite). Mirrors what `login` does after the API call:
   * persist tokens + warm the /me cache.
   */
  adoptTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  /**
   * Switch the active organization view. Pure client-side state — the
   * /orgs/:orgId/* routes themselves probe membership in real time on
   * every request, so a stale or unauthorized selection just yields a
   * clean 403 from the next API call. Does NOT re-issue tokens or touch
   * the WS connection.
   */
  selectOrganization: (organizationId: string) => Promise<void>;
  refreshMe: () => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

const SELECTED_ORG_KEY = "first-tree-hub:selectedOrganizationId";

function readSelectedOrgId(): string | null {
  try {
    return localStorage.getItem(SELECTED_ORG_KEY);
  } catch {
    return null;
  }
}

function writeSelectedOrgId(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(SELECTED_ORG_KEY);
    else localStorage.setItem(SELECTED_ORG_KEY, value);
  } catch {
    // localStorage may be denied in private mode — ignore.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());
  const [user, setUser] = useState<MeUser | null>(null);
  const [memberships, setMemberships] = useState<MeMembership[]>([]);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => {
    const init = readSelectedOrgId();
    // Sync the API client's module-level override on first paint so the
    // first wave of requests (made before fetchMe resolves) already carries
    // the correct `?organizationId=` query (codex P1 #2 fix).
    setApiSelectedOrganizationId(init);
    return init;
  });
  const [onboardingStep, setOnboardingStep] = useState<"connect" | "create_agent" | "completed" | null>(null);
  const [onboardingDismissedAt, setOnboardingDismissedAt] = useState<string | null>(null);
  // Stays false until the first fetchMe settles. Unauthenticated visitors
  // never need /me, so the gate also flips for them via the unauth branch
  // below — RequireAuth only blocks the loading frame when the user IS
  // authenticated.
  const [meLoaded, setMeLoaded] = useState(false);

  const logout = useCallback(() => {
    clearStoredTokens();
    writeSelectedOrgId(null);
    setApiSelectedOrganizationId(null);
    queryClient.clear();
    setIsAuthenticated(false);
    setUser(null);
    setMemberships([]);
    setSelectedOrgId(null);
    setOnboardingStep(null);
    setOnboardingDismissedAt(null);
    setMeLoaded(false);
  }, [queryClient]);

  const fetchMe = useCallback(async () => {
    try {
      const data = await api.get<MeResponse>("/me");
      setUser(data.user ?? null);
      const ms = data.memberships ?? [];
      setMemberships(ms);
      const nextStep = data.onboarding?.step ?? null;
      setOnboardingStep(nextStep);
      setOnboardingDismissedAt(data.onboarding?.dismissedAt ?? null);
      // Drop the join-path flag once onboarding is complete so a later
      // incomplete state (e.g. user deletes their client) doesn't reuse a
      // stale "you've joined {team}" headline that no longer fits.
      if (nextStep === "completed") clearOnboardingJoinPath();

      // Reconcile selectedOrgId: stored value wins if still valid, else
      // /me's `defaultOrganizationId`, else the first active membership.
      setSelectedOrgId((prev) => {
        const valid = prev && ms.some((m) => m.organizationId === prev) ? prev : null;
        if (valid) {
          setApiSelectedOrganizationId(valid);
          return valid;
        }
        const fallback = data.defaultOrganizationId ?? ms[0]?.organizationId ?? null;
        writeSelectedOrgId(fallback);
        setApiSelectedOrganizationId(fallback);
        return fallback;
      });
    } catch {
      // If /me fails, the UI falls back to hiding admin features.
    } finally {
      // Always flip the gate — even on error — so RequireAuth doesn't hang
      // the dashboard forever if /me is briefly unreachable.
      setMeLoaded(true);
    }
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const tokens = await loginApi(username, password);
      setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe],
  );

  const adoptTokens = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      setStoredTokens(tokens);
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe],
  );

  const selectOrganization = useCallback(
    async (organizationId: string) => {
      // Pure client-side switch — the /orgs/:orgId/* routes probe
      // membership in real time on every request, so a stale or
      // unauthorized selection just yields a clean 403 from the next call.
      writeSelectedOrgId(organizationId);
      setApiSelectedOrganizationId(organizationId);
      // Drop every cached React Query result keyed off the previous org —
      // the next render refetches with the new prefix so a non-default org
      // never reuses the previous selection's data.
      queryClient.clear();
      setSelectedOrgId(organizationId);
      await fetchMe();
    },
    [fetchMe, queryClient],
  );

  const dismissOnboarding = useCallback(async () => {
    // Optimistic: stamp client-side immediately so the stepper unmounts
    // without a round-trip. Server returns the canonical timestamp.
    let prior: string | null = null;
    setOnboardingDismissedAt((p) => {
      prior = p;
      return new Date().toISOString();
    });
    try {
      const res = await api.patch<{ dismissedAt: string | null }>("/me/onboarding", { dismissed: true });
      if (res?.dismissedAt) setOnboardingDismissedAt(res.dismissedAt);
    } catch {
      // Restore the prior value rather than blanket-clearing — the user
      // may have already had a non-null timestamp from a previous dismiss.
      setOnboardingDismissedAt(prior);
    }
  }, []);

  // Fetch member info on initial load if already authenticated
  useEffect(() => {
    if (isAuthenticated && !user) {
      fetchMe();
    }
  }, [isAuthenticated, user, fetchMe]);

  // Listen for auth failure dispatched by the API client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
  }, [logout]);

  const currentMembership = useMemo<MeMembership | null>(() => {
    if (memberships.length === 0) return null;
    const match = memberships.find((m) => m.organizationId === selectedOrgId);
    return match ?? memberships[0] ?? null;
  }, [memberships, selectedOrgId]);

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        meLoaded,
        user,
        memberships,
        currentMembership,
        organizationId: currentMembership?.organizationId ?? null,
        memberId: currentMembership?.id ?? null,
        role: currentMembership?.role ?? null,
        agentId: currentMembership?.agentId ?? null,
        onboardingStep,
        onboardingDismissedAt,
        dismissOnboarding,
        login,
        adoptTokens,
        selectOrganization,
        refreshMe: fetchMe,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
