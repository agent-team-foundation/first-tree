import type { MeMembership } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { login as loginApi } from "../api/auth.js";
import {
  api,
  clearStoredTokens,
  getStoredTokens,
  setApiSelectedOrganizationId,
  setStoredTokens,
} from "../api/client.js";
import { markOnboardingCompleted as postOnboardingCompleted } from "../api/onboarding-events.js";
import { clearOnboardingJoinPath, clearOnboardingSessionFlags } from "../utils/onboarding-flags.js";

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
    /** ISO timestamp when the user dismissed onboarding ("finish later"), else null. */
    dismissedAt?: string | null;
    /**
     * ISO timestamp when the user finished the kickoff (Context Tree) step.
     * Distinct from `dismissedAt` (which only hides onboarding, leaving it
     * resumable). Once set, the Settings → Onboarding entry point disappears
     * permanently.
     */
    completedAt?: string | null;
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
  /**
   * Display name of the current org (e.g. `${login}'s team` for a fresh
   * solo signup, or the renamed value once the user has gone through
   * Step 1). Drives the onboarding gate's "is this still the auto-named
   * default" check without re-fetching `/me/organizations`.
   */
  teamDisplayName: string | null;
  /**
   * `true` when the current org has at least one ACTIVE member besides
   * the caller (`COUNT(members) > 1`). Sourced from `/me`'s per-membership
   * count, so it stays accurate cross-tab / cross-device — the prior
   * `sessionStorage.joinPath` flag could not.
   */
  orgHasOtherMembers: boolean;
  /**
   * `true` when the currently selected org holds a non-human agent this
   * member can use — one they manage themselves OR one set to
   * `visibility="organization"`. Sourced from `/me`'s per-membership
   * `hasUsableAgent`. This is the org-scoped readiness the onboarding gate
   * uses for the create-agent step, replacing the account-level
   * `onboardingCompletedAt` short-circuit (which wrongly skipped onboarding
   * for a returning user joining a brand-new / all-private org).
   */
  currentOrgHasUsableAgent: boolean;
  onboardingStep: "connect" | "create_agent" | "completed" | null;
  /**
   * ISO timestamp when the user dismissed onboarding ("finish later").
   * Decoupled from `onboardingStep` — `null` means onboarding is still
   * pending, so the workspace root redirects the user into `/onboarding`.
   */
  onboardingDismissedAt: string | null;
  /**
   * ISO timestamp when the user finished the kickoff (Context Tree) step. Once
   * non-null, the Settings → Onboarding sidebar entry and Resume button
   * disappear permanently — subsequent config edits go through Settings → Team
   * and the per-agent settings pages. `null` while setup is still incomplete
   * OR while the user has only dismissed (not finished) onboarding.
   */
  onboardingCompletedAt: string | null;
  /**
   * PATCH `/me/onboarding { dismissed: true }`. Optimistically flips
   * `onboardingDismissedAt` so the workspace stops redirecting into onboarding.
   */
  dismissOnboarding: () => Promise<void>;
  /**
   * PATCH `/me/onboarding { dismissed: false }`. Clears `onboardingDismissedAt`
   * so onboarding is pending again (the root redirects into `/onboarding`).
   * Used by the Settings → Setup "Resume setup" toggle.
   */
  restoreOnboarding: () => Promise<void>;
  /**
   * POST `/me/onboarding-completed`. Optimistically stamps
   * `onboardingCompletedAt` so the Settings → Onboarding sidebar entry
   * unmounts immediately and `/settings/onboarding` redirects on the next
   * render. Idempotent server-side. Called at Step 3 terminal-success
   * points (admin Continue, invitee Confirm / Continue).
   */
  markOnboardingCompleted: () => Promise<void>;
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

// Exported so DEV-only preview pages (e.g. /preview/resources) can render real
// authenticated pages under a faked membership without a backend. Not used by
// production app code, which goes through `AuthProvider` / `useAuth`.
export const AuthContext = createContext<AuthContextValue | null>(null);

const SELECTED_ORG_KEY = "first-tree:selectedOrganizationId";

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
  const [onboardingCompletedAt, setOnboardingCompletedAt] = useState<string | null>(null);
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
    // Drop per-tab onboarding flags so the next login (different user, or
    // same user post-DB-reset in dev) doesn't inherit a stale "Step 1
    // confirmed" / "Step 3 dismissed" / agent uuid / draft from the prior
    // identity.
    clearOnboardingSessionFlags();
    setIsAuthenticated(false);
    setUser(null);
    setMemberships([]);
    setSelectedOrgId(null);
    setOnboardingStep(null);
    setOnboardingDismissedAt(null);
    setOnboardingCompletedAt(null);
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
      setOnboardingCompletedAt(data.onboarding?.completedAt ?? null);
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

  // Track the latest dismissal stamp in a ref so `dismissOnboarding`'s
  // rollback path can read it synchronously without depending on the
  // setState updater closure (concurrent rendering can drop+re-run
  // updaters, making the captured value unreliable).
  const dismissedAtRef = useRef<string | null>(null);
  useEffect(() => {
    dismissedAtRef.current = onboardingDismissedAt;
  }, [onboardingDismissedAt]);

  const dismissOnboarding = useCallback(async () => {
    // Optimistic: stamp client-side immediately so the workspace stops
    // redirecting into onboarding without a round-trip. Server returns the
    // canonical timestamp.
    const prior = dismissedAtRef.current;
    setOnboardingDismissedAt(new Date().toISOString());
    try {
      const res = await api.patch<{ dismissedAt: string | null }>("/me/onboarding", { dismissed: true });
      if (res?.dismissedAt) setOnboardingDismissedAt(res.dismissedAt);
    } catch {
      // Restore the prior value rather than blanket-clearing — the user
      // may have already had a non-null timestamp from a previous dismiss.
      setOnboardingDismissedAt(prior);
    }
  }, []);

  const restoreOnboarding = useCallback(async () => {
    // Optimistic clear so onboarding is pending again immediately.
    const prior = dismissedAtRef.current;
    setOnboardingDismissedAt(null);
    try {
      await api.patch<{ dismissedAt: string | null }>("/me/onboarding", { dismissed: false });
    } catch {
      setOnboardingDismissedAt(prior);
    }
  }, []);

  const markOnboardingCompleted = useCallback(async () => {
    // Optimistic: stamp immediately so the Settings sidebar gate and the
    // /settings/onboarding redirect read the new state on the very next
    // render. Server stamp is canonical but it's not echoed back — the next
    // /me fetch will reconcile if the value somehow drifts (e.g. /me was
    // refetched mid-flight before the optimistic write landed). We don't
    // roll back on error: the user has already finished Step 3 and is
    // navigating away, so a network blip here just means the sidebar entry
    // lingers until the next /me — strictly less wrong than briefly
    // un-completing the user.
    setOnboardingCompletedAt((prev) => prev ?? new Date().toISOString());
    await postOnboardingCompleted();
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
        teamDisplayName: currentMembership?.organizationName ?? null,
        orgHasOtherMembers: currentMembership?.orgHasOtherMembers ?? false,
        currentOrgHasUsableAgent: currentMembership?.hasUsableAgent ?? false,
        onboardingStep,
        onboardingDismissedAt,
        onboardingCompletedAt,
        dismissOnboarding,
        restoreOnboarding,
        markOnboardingCompleted,
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
