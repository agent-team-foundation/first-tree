import type { MeMembership, OrgBrief } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { trackEvent } from "../analytics.js";
import { login as loginApi } from "../api/auth.js";
import {
  ADMIN_WS_ORG_CHANGED_EVENT,
  api,
  clearStoredTokens,
  getStoredTokens,
  setApiSelectedOrganizationId,
  setStoredTokens,
} from "../api/client.js";
import { markOnboardingCompleted as postOnboardingCompleted } from "../api/onboarding-events.js";
import {
  BROWSER_STORAGE_SCOPE_INVALIDATED_EVENT,
  type BrowserStorageScope,
  captureBrowserStorageScope,
  clearPersistentBrowserStorage,
  invalidateBrowserStorageScope,
  setBrowserStorageUser,
} from "../lib/browser-storage-scope.js";
import { clearOnboardingJoinPath, clearOnboardingSessionFlags } from "../utils/onboarding-flags.js";
import { type LogoutResult, publishLogoutIncomplete } from "./logout-recovery.js";

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
  /** Deployment-level feature switches (presentation-only; routes enforce). */
  features?: {
    /** Document review (docloop): the Context → Documents sub-tab. */
    docs?: boolean;
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
   * `hasUsableAgent`. This is the general product availability bit for team
   * and chat surfaces; onboarding uses `currentOrgHasPersonalAgent` instead.
   */
  currentOrgHasUsableAgent: boolean;
  /**
   * `true` when the currently selected membership manages at least one active
   * non-human agent in the org. This is onboarding's create-agent readiness
   * bit; a team-shared org-visible agent owned by another member does not
   * satisfy it.
   */
  currentOrgHasPersonalAgent: boolean;
  /** Document review (docloop) surface is enabled on this deployment. */
  docsEnabled: boolean;
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
   * disappear permanently — subsequent team-name edits go through the
   * header-left TeamSwitcher and per-agent edits go through agent settings
   * pages. `null` while setup is still incomplete OR while the user has only
   * dismissed (not finished) onboarding.
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
   * clean 403 from the next API call. Does NOT re-issue tokens; it does
   * signal the org-scoped admin WebSocket to reconnect against the new
   * org (`ADMIN_WS_ORG_CHANGED_EVENT`).
   */
  selectOrganization: (organizationId: string) => Promise<void>;
  /**
   * The org a switch is transitioning to, or `null` when no switch is in
   * flight. Set by the team switcher when a switch starts and cleared when it
   * settles (or fails). It is the single signal that drives the optimistic
   * anchor label, the in-row spinner + disabled list, and the global
   * "Switching to {name}…" transition veil — consolidating the per-component
   * blank flash into one intentional overlay. `selectOrganization` itself is
   * unchanged; this is purely the in-flight UI state wrapped around it.
   */
  switchingOrg: OrgBrief | null;
  setSwitchingOrg: (org: OrgBrief | null) => void;
  refreshMe: () => Promise<void>;
  logout: (options?: LogoutOptions) => undefined | Promise<LogoutResult>;
  logoutStatus?: "idle" | "purging" | "incomplete";
};

export type LogoutOptions = {
  broadcast?: boolean;
  clearTokens?: boolean;
  recovery?: boolean;
  protectReplacementTokens?: boolean;
  generation?: number;
  onIncomplete?: (retry: () => Promise<LogoutResult>) => void;
  scope?: BrowserStorageScope;
};

// Exported so DEV-only preview pages (e.g. /preview/resources) can render real
// authenticated pages under a faked membership without a backend. Not used by
// production app code, which goes through `AuthProvider` / `useAuth`.
export const AuthContext = createContext<AuthContextValue | null>(null);

const SELECTED_ORG_KEY = "first-tree:selectedOrganizationId";

// The persisted org selection is scoped per user — keyed by `${SELECTED_ORG_KEY}:${userId}`
// — so a shared browser never lets one account inherit another's last-used team
// (two accounts can be members of the same org, so validating "is an active
// membership" is not enough). The userId comes from the access token's `sub`
// claim (a plain JWT, no decode lib needed) so the first-paint pre-seed can read
// the right key before /me resolves.
function userIdFromToken(): string | null {
  try {
    const payload = getStoredTokens()?.accessToken?.split(".")[1];
    if (!payload) return null;
    const decoded: unknown = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof decoded === "object" && decoded !== null && "sub" in decoded) {
      const sub = decoded.sub;
      return typeof sub === "string" ? sub : null;
    }
    return null;
  } catch {
    return null;
  }
}

function orgStorageKey(userId: string): string {
  return `${SELECTED_ORG_KEY}:${userId}`;
}

function readSelectedOrgId(userId: string | null): string | null {
  if (!userId) return null;
  try {
    return localStorage.getItem(orgStorageKey(userId));
  } catch {
    return null;
  }
}

function writeSelectedOrgId(userId: string | null, value: string | null): void {
  if (!userId) return;
  try {
    if (value === null) localStorage.removeItem(orgStorageKey(userId));
    else localStorage.setItem(orgStorageKey(userId), value);
  } catch {
    // localStorage may be denied in private mode — ignore.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!getStoredTokens());
  const [user, setUser] = useState<MeUser | null>(null);
  const [memberships, setMemberships] = useState<MeMembership[]>([]);
  const [docsEnabled, setDocsEnabled] = useState(false);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(() => {
    const tokenUserId = userIdFromToken();
    // Seed the browser cache scope from the JWT before /me resolves so an
    // early 401/logout can still purge the departing account's stores.
    setBrowserStorageUser(tokenUserId);
    const init = readSelectedOrgId(tokenUserId);
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
  const authGenerationRef = useRef(0);
  // In-flight org-switch target (drives the switcher's optimistic anchor, the
  // row spinner, and the global transition veil). Lives here so the veil
  // (mounted in the layout) and the switcher (in the header) read one source.
  const [switchingOrg, setSwitchingOrg] = useState<OrgBrief | null>(null);
  const [logoutStatus, setLogoutStatus] = useState<"idle" | "purging" | "incomplete">("idle");

  const commitLocalLogoutState = useCallback(() => {
    setApiSelectedOrganizationId(null);
    queryClient.clear();
    clearOnboardingSessionFlags();
    setBrowserStorageUser(null);
    setIsAuthenticated(false);
    setUser(null);
    setMemberships([]);
    setSelectedOrgId(null);
    setOnboardingStep(null);
    setOnboardingDismissedAt(null);
    setOnboardingCompletedAt(null);
    setDocsEnabled(false);
    setMeLoaded(false);
    setSwitchingOrg(null);
  }, [queryClient]);

  const logout = useCallback(
    async (options: LogoutOptions = {}): Promise<LogoutResult> => {
      const departingScope = options.scope ?? captureBrowserStorageScope();
      if (options.broadcast !== false) invalidateBrowserStorageScope(departingScope);
      const logoutGeneration = options.generation ?? authGenerationRef.current + 1;
      const canFinalize = options.generation === undefined || options.generation === authGenerationRef.current;
      if (options.generation === undefined) authGenerationRef.current = logoutGeneration;
      const retry = () => logout({ ...options, generation: logoutGeneration, recovery: false, scope: departingScope });
      if (canFinalize) setLogoutStatus("purging");
      try {
        await clearPersistentBrowserStorage(departingScope);
      } catch {
        if (!canFinalize || authGenerationRef.current !== logoutGeneration) {
          setLogoutStatus("idle");
          options.onIncomplete?.(retry);
          if (options.recovery) publishLogoutIncomplete(retry);
          return "incomplete";
        }
        setLogoutStatus("incomplete");
        options.onIncomplete?.(retry);
        if (options.recovery) {
          commitLocalLogoutState();
          publishLogoutIncomplete(retry);
        }
        return "incomplete";
      }
      if (authGenerationRef.current !== logoutGeneration) {
        setLogoutStatus("idle");
        return "superseded";
      }
      commitLocalLogoutState();
      // A different tab may have installed a replacement account while this
      // tab was purging the departing scope. Never clear that newer account's
      // credential as a side effect of the old logout.
      const currentTokenOwner = userIdFromToken();
      const canClearCredential =
        !options.protectReplacementTokens || !departingScope.userId || currentTokenOwner === departingScope.userId;
      if (options.clearTokens !== false && canClearCredential) {
        clearStoredTokens();
      }
      setLogoutStatus("idle");
      return "completed";
    },
    [commitLocalLogoutState],
  );

  const fetchMe = useCallback(async () => {
    const generation = authGenerationRef.current;
    try {
      const data = await api.get<MeResponse>("/me");
      if (generation !== authGenerationRef.current) return;
      setBrowserStorageUser(data.user?.id ?? null);
      setUser(data.user ?? null);
      const ms = data.memberships ?? [];
      setMemberships(ms);
      setDocsEnabled(data.features?.docs === true);
      const nextStep = data.onboarding?.step ?? null;
      setOnboardingStep(nextStep);
      // Legacy fallback for older /me payloads. Modern payloads carry these
      // stamps per membership and the provider derives the public values from
      // currentMembership below.
      setOnboardingDismissedAt(data.onboarding?.dismissedAt ?? null);
      setOnboardingCompletedAt(data.onboarding?.completedAt ?? null);
      // Drop the join-path flag once onboarding is complete so a later
      // incomplete state (e.g. user deletes their client) doesn't reuse a
      // stale "you've joined {team}" headline that no longer fits.
      if (nextStep === "completed") clearOnboardingJoinPath();

      // Reconcile selectedOrgId, each candidate only if it's still an active
      // membership: (1) the in-memory selection, (2) this user's persisted
      // last-used org — if still present — then (3) /me's
      // `defaultOrganizationId` (most-recent),
      // (4) the first active membership.
      const userId = data.user?.id ?? null;
      setSelectedOrgId((prev) => {
        const isMember = (id: string | null): id is string => !!id && ms.some((m) => m.organizationId === id);
        const prevValid = isMember(prev) ? prev : null;
        const stored = readSelectedOrgId(userId);
        const storedValid = isMember(stored) ? stored : null;
        const candidate = prevValid ?? storedValid;
        if (candidate) {
          writeSelectedOrgId(userId, candidate);
          setApiSelectedOrganizationId(candidate);
          return candidate;
        }
        const fallback = data.defaultOrganizationId ?? ms[0]?.organizationId ?? null;
        writeSelectedOrgId(userId, fallback);
        setApiSelectedOrganizationId(fallback);
        return fallback;
      });
    } catch {
      if (generation !== authGenerationRef.current) return;
      // Keep the JWT-derived scope while a non-auth /me failure is retryable;
      // logout must still know which account's browser data to purge.
    } finally {
      if (generation === authGenerationRef.current) {
        // Always flip the gate — even on error — so RequireAuth doesn't hang
        // the dashboard forever if /me is briefly unreachable.
        setMeLoaded(true);
      }
    }
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const tokens = await loginApi(username, password);
      const departingScope = captureBrowserStorageScope();
      if (departingScope.userId) invalidateBrowserStorageScope(departingScope);
      setBrowserStorageUser(null);
      queryClient.clear();
      setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      setLogoutStatus("idle");
      authGenerationRef.current += 1;
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe, queryClient],
  );

  const adoptTokens = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      const departingScope = captureBrowserStorageScope();
      if (departingScope.userId) invalidateBrowserStorageScope(departingScope);
      setBrowserStorageUser(null);
      queryClient.clear();
      setStoredTokens(tokens);
      setLogoutStatus("idle");
      authGenerationRef.current += 1;
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe, queryClient],
  );

  const selectOrganization = useCallback(
    async (organizationId: string) => {
      // Pure client-side switch — the /orgs/:orgId/* routes probe
      // membership in real time on every request, so a stale or
      // unauthorized selection just yields a clean 403 from the next call.
      // Persist under the current user's key (token `sub`) so the selection
      // is restored only for this account.
      writeSelectedOrgId(userIdFromToken(), organizationId);
      setApiSelectedOrganizationId(organizationId);
      // The org-scoped admin WebSocket is not re-opened by React state changes;
      // signal it to reconnect against the newly selected org so realtime frames
      // follow the switch instead of staying on the previously selected org.
      window.dispatchEvent(new CustomEvent(ADMIN_WS_ORG_CHANGED_EVENT));
      // Drop every cached React Query result keyed off the previous org —
      // the next render refetches with the new prefix so a non-default org
      // never reuses the previous selection's data.
      queryClient.clear();
      setSelectedOrgId(organizationId);
      await fetchMe();
    },
    [fetchMe, queryClient],
  );

  const currentMembership = useMemo<MeMembership | null>(() => {
    if (memberships.length === 0) return null;
    const match = memberships.find((m) => m.organizationId === selectedOrgId);
    return match ?? memberships[0] ?? null;
  }, [memberships, selectedOrgId]);

  const currentOnboardingDismissedAt = currentMembership
    ? currentMembership.onboardingSuppressedAt
    : onboardingDismissedAt;
  const currentOnboardingCompletedAt = currentMembership
    ? currentMembership.onboardingCompletedAt
    : onboardingCompletedAt;

  const patchMembershipOnboarding = useCallback(
    (
      patch: Partial<
        Pick<MeMembership, "onboardingSuppressedAt" | "onboardingSuppressedReason" | "onboardingCompletedAt">
      >,
    ) => {
      const memberId = currentMembership?.id;
      if (!memberId) return;
      setMemberships((prev) => prev.map((m) => (m.id === memberId ? { ...m, ...patch } : m)));
    },
    [currentMembership?.id],
  );

  // Track the latest dismissal stamp in a ref so `dismissOnboarding`'s
  // rollback path can read it synchronously without depending on the
  // setState updater closure (concurrent rendering can drop+re-run
  // updaters, making the captured value unreliable).
  const dismissedAtRef = useRef<string | null>(null);
  useEffect(() => {
    dismissedAtRef.current = currentOnboardingDismissedAt;
  }, [currentOnboardingDismissedAt]);

  const dismissOnboarding = useCallback(async () => {
    // Optimistic: stamp client-side immediately so the workspace stops
    // redirecting into onboarding without a round-trip. Server returns the
    // canonical timestamp.
    const prior = dismissedAtRef.current;
    const organizationId = currentMembership?.organizationId;
    const optimistic = new Date().toISOString();
    setOnboardingDismissedAt(optimistic);
    patchMembershipOnboarding({ onboardingSuppressedAt: optimistic, onboardingSuppressedReason: "finish_later" });
    try {
      const res = await api.patch<{ dismissedAt: string | null }>("/me/onboarding", {
        dismissed: true,
        ...(organizationId ? { organizationId } : {}),
      });
      if (res?.dismissedAt) {
        setOnboardingDismissedAt(res.dismissedAt);
        patchMembershipOnboarding({
          onboardingSuppressedAt: res.dismissedAt,
          onboardingSuppressedReason: currentMembership?.onboardingSuppressedReason ?? "finish_later",
        });
      }
    } catch {
      // Restore the prior value rather than blanket-clearing — the user
      // may have already had a non-null timestamp from a previous dismiss.
      setOnboardingDismissedAt(prior);
      patchMembershipOnboarding({
        onboardingSuppressedAt: prior,
        onboardingSuppressedReason: prior ? (currentMembership?.onboardingSuppressedReason ?? "finish_later") : null,
      });
    }
  }, [currentMembership?.onboardingSuppressedReason, currentMembership?.organizationId, patchMembershipOnboarding]);

  const restoreOnboarding = useCallback(async () => {
    // Optimistic clear so onboarding is pending again immediately.
    const prior = dismissedAtRef.current;
    const priorReason = currentMembership?.onboardingSuppressedReason ?? null;
    const organizationId = currentMembership?.organizationId;
    setOnboardingDismissedAt(null);
    patchMembershipOnboarding({ onboardingSuppressedAt: null, onboardingSuppressedReason: null });
    try {
      const res = await api.patch<{ dismissedAt: string | null }>("/me/onboarding", {
        dismissed: false,
        ...(organizationId ? { organizationId } : {}),
      });
      const next = res?.dismissedAt ?? null;
      setOnboardingDismissedAt(next);
      patchMembershipOnboarding({
        onboardingSuppressedAt: next,
        onboardingSuppressedReason: next ? (priorReason ?? "completed") : null,
      });
    } catch {
      setOnboardingDismissedAt(prior);
      patchMembershipOnboarding({ onboardingSuppressedAt: prior, onboardingSuppressedReason: priorReason });
    }
  }, [currentMembership?.onboardingSuppressedReason, currentMembership?.organizationId, patchMembershipOnboarding]);

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
    const organizationId = currentMembership?.organizationId;
    const optimistic = new Date().toISOString();
    // Fire the GA `sign_up` conversion exactly once per *account*, on the
    // user's first ever onboarding completion. Completion is stamped per
    // membership (a user can belong to several orgs), so a per-membership gate
    // would re-fire every time the same person finishes onboarding in a new
    // team — that's not a new signup. The account-level "never completed
    // anywhere" signal is: no membership carries a completion stamp AND the
    // legacy top-level stamp is empty (older /me payloads). trackEvent
    // self-gates to the production host, so dev / StrictMode re-invokes can't
    // pollute GA either way.
    const firstCompletion = !onboardingCompletedAt && memberships.every((m) => !m.onboardingCompletedAt);
    setOnboardingCompletedAt((prev) => prev ?? optimistic);
    setOnboardingDismissedAt((prev) => prev ?? optimistic);
    patchMembershipOnboarding({
      onboardingCompletedAt: currentMembership?.onboardingCompletedAt ?? optimistic,
      onboardingSuppressedAt: currentMembership?.onboardingSuppressedAt ?? optimistic,
      onboardingSuppressedReason: "completed",
    });
    if (firstCompletion) trackEvent("sign_up");
    await postOnboardingCompleted(organizationId ?? undefined);
  }, [
    onboardingCompletedAt,
    memberships,
    currentMembership?.onboardingCompletedAt,
    currentMembership?.onboardingSuppressedAt,
    currentMembership?.organizationId,
    patchMembershipOnboarding,
  ]);

  // Fetch member info on initial load if already authenticated
  useEffect(() => {
    if (isAuthenticated && !user) {
      fetchMe();
    }
  }, [isAuthenticated, user, fetchMe]);

  // Listen for auth failure dispatched by the API client
  useEffect(() => {
    const handler = () => {
      void Promise.resolve(logout({ recovery: true }));
    };
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
  }, [logout]);

  useEffect(() => {
    const handler = (event: Event) => {
      const scope = (event as CustomEvent<{ scope?: BrowserStorageScope }>).detail?.scope;
      void Promise.resolve(logout({ broadcast: false, protectReplacementTokens: true, recovery: true, scope }));
    };
    window.addEventListener(BROWSER_STORAGE_SCOPE_INVALIDATED_EVENT, handler);
    return () => window.removeEventListener(BROWSER_STORAGE_SCOPE_INVALIDATED_EVENT, handler);
  }, [logout]);

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
        currentOrgHasPersonalAgent: currentMembership?.hasPersonalAgent ?? false,
        docsEnabled,
        onboardingStep,
        onboardingDismissedAt: currentOnboardingDismissedAt,
        onboardingCompletedAt: currentOnboardingCompletedAt,
        dismissOnboarding,
        restoreOnboarding,
        markOnboardingCompleted,
        login,
        adoptTokens,
        selectOrganization,
        switchingOrg,
        setSwitchingOrg,
        refreshMe: fetchMe,
        logout,
        logoutStatus,
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
