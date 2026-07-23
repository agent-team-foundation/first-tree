import type { MeMembership, OrgBrief } from "@first-tree/shared";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import { purgeAccountLocalData, purgeLegacyUnscopedStores, setStorageNamespace } from "../api/storage-scope.js";
import { clearChatSummaryPrefs } from "../pages/workspace/center/chat-summary.js";
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
     * resumable). This completes first-run routing but does not hide the
     * permanent Settings → Setup overview.
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
   * ISO timestamp when the user finished the first-run flow. This controls
   * onboarding redirects only; the permanent Settings → Setup overview remains
   * available after completion. `null` while onboarding is incomplete or only
   * dismissed.
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
   * `onboardingCompletedAt` so first-run routing can settle immediately.
   * Idempotent server-side. Called at Step 3 terminal-success points (admin
   * Continue, invitee Confirm / Continue).
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
  logout: () => void;
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
    const init = readSelectedOrgId(userIdFromToken());
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
  // In-flight org-switch target (drives the switcher's optimistic anchor, the
  // row spinner, and the global transition veil). Lives here so the veil
  // (mounted in the layout) and the switcher (in the header) read one source.
  const [switchingOrg, setSwitchingOrg] = useState<OrgBrief | null>(null);

  const logout = useCallback(() => {
    // SEC-042: purge this account's per-browser session data (namespaced
    // message/read-state/image IndexedDBs, drafts in both scope formats,
    // legacy global DBs). The token's `sub` is captured BEFORE clearing
    // tokens and passed as the fallback purge target — it only matters when
    // this session's /me never resolved (storage-scope's namespace is still
    // stale from a previous session); once /me has resolved, the namespace
    // set from `user.id` equals the token's (org keying relies on the same
    // equivalence). Fire-and-forget: target namespaces are write-blocked
    // synchronously, the deletion itself settles asynchronously.
    const tokenUserId = userIdFromToken();
    void purgeAccountLocalData(tokenUserId);
    // Per-chat summary prefs embed chatIds — account-linked, so they go too.
    clearChatSummaryPrefs();
    // Post-logout state is anonymous; the stores' next operations either land
    // in the (purged, write-blocked) anon namespace or wait for the next
    // fetchMe to set the new account's namespace.
    setStorageNamespace(null);
    clearStoredTokens();
    // Keep the persisted last-used org (no writeSelectedOrgId(null) here) so a
    // returning sign-in lands back in the org this user left rather than their
    // most-recently-joined one. It's stored per-user (keyed by the token's
    // `sub`), so a different account on the same browser can never inherit it.
    // Clear only the in-memory + API-client selection so nothing org-scoped
    // fires before the next fetchMe reconciles.
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
    setDocsEnabled(false);
    setMeLoaded(false);
    setSwitchingOrg(null);
  }, [queryClient]);

  const fetchMe = useCallback(async () => {
    try {
      const data = await api.get<MeResponse>("/me");
      setUser(data.user ?? null);
      // Point every persistent browser store at this account's namespace
      // BEFORE meLoaded flips and the gated UI starts firing store
      // reads/writes — otherwise the first wave would land in the anonymous
      // (or a previous account's) namespace (SEC-042).
      setStorageNamespace(data.user?.id ?? null);
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
      // last-used org — survives logout so a returning user lands back in the
      // org they left — then (3) /me's `defaultOrganizationId` (most-recent),
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
    // Optimistic: stamp immediately so first-run routing reads the new state
    // on the very next render. Server stamp is canonical but isn't echoed
    // back; the next /me fetch reconciles any drift. We don't roll back on
    // error because the user has already finished Step 3 and is navigating
    // away.
    const organizationId = currentMembership?.organizationId;
    const optimistic = new Date().toISOString();
    setOnboardingCompletedAt((prev) => prev ?? optimistic);
    setOnboardingDismissedAt((prev) => prev ?? optimistic);
    patchMembershipOnboarding({
      onboardingCompletedAt: currentMembership?.onboardingCompletedAt ?? optimistic,
      onboardingSuppressedAt: currentMembership?.onboardingSuppressedAt ?? optimistic,
      onboardingSuppressedReason: "completed",
    });
    await postOnboardingCompleted(organizationId ?? undefined);
  }, [
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

  // SEC-042: one-shot cleanup of the pre-namespacing global IndexedDBs
  // (`first-tree-chat-cache`, `first-tree-images`) left by older builds. Their
  // content is cache-only (the server re-hydrates) and not attributable to an
  // account, so the safe disposition is deletion. Fire-and-forget.
  useEffect(() => {
    void purgeLegacyUnscopedStores();
  }, []);

  // Listen for auth failure dispatched by the API client
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener("auth:logout", handler);
    return () => window.removeEventListener("auth:logout", handler);
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
