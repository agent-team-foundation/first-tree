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
     * permanent Settings → Getting Started overview.
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
   * `true` once an authoritative live `/me` snapshot has been fully applied
   * in this session. Distinct from `meLoaded`: an initial transport failure
   * flips `meLoaded` (fail-soft shell) but leaves this false. Resets on
   * logout and every new login/adopted-token session. Flows that need real
   * Team authority (e.g. the Template use-intent) must wait for this, not
   * just `meLoaded`.
   */
  meAuthoritative: boolean;
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
   * onboarding redirects only; the permanent Settings → Getting Started overview remains
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
   * Used by the Settings → Getting Started "Resume setup" toggle.
   */
  restoreOnboarding: () => Promise<void>;
  /**
   * POST `/me/onboarding-completed`. Optimistically stamps
   * `onboardingCompletedAt` so first-run routing can settle immediately.
   * Idempotent server-side. Called at Step 3 terminal-success points (admin
   * Continue, invitee Confirm / Continue).
   */
  markOnboardingCompleted: () => Promise<void>;
  /**
   * Mirror a membership stamp already written atomically by the successful
   * onboarding kickoff request. This is local projection only: it must never
   * be called before the server confirms the chat exists.
   */
  applyOnboardingKickoffStamp: (stamp: "completed" | "invitee_skip") => void;
  login: (username: string, password: string) => Promise<void>;
  /**
   * Adopt a token pair handed in from a non-login surface (OAuth fragment
   * consumer, accept-invite). Mirrors what `login` does after the API call:
   * persist tokens + warm the /me cache.
   */
  adoptTokens: (tokens: { accessToken: string; refreshToken: string }) => Promise<void>;
  /**
   * Switch the active organization view. The org-scoped routes probe
   * membership in real time on every request, and the post-switch `/me` is
   * the switch's confirmation authority: this promise REJECTS when that
   * `/me` cannot be fetched. On such a transport failure every optimistic
   * write (React selection, per-user persisted org, API override, admin WS
   * target, and any cache written during the optimistic window) is rolled
   * back to the pre-switch confirmed org before the rejection propagates —
   * callers must handle the rejection (inline error / retry affordance).
   * Does NOT re-issue tokens; it does signal the org-scoped admin WebSocket
   * to reconnect against the new org (`ADMIN_WS_ORG_CHANGED_EVENT`).
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

/** Marker for a /me response from a stale session or identity (discarded, zero mutation). */
class StaleMeError extends Error {
  constructor() {
    super("stale /me response discarded");
    this.name = "StaleMeError";
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
  // Selection mirrors for event handlers (closures can't read fresh React
  // state). `selectedOrgIdRef` tracks the CURRENT selection, including an
  // optimistic switch target. `confirmedOrgIdRef` advances ONLY when a /me
  // has authoritatively settled the selection — it is the rollback baseline,
  // so an unconfirmed optimistic target can never become one.
  const selectedOrgIdRef = useRef<string | null>(selectedOrgId);
  const confirmedOrgIdRef = useRef<string | null>(null);
  // Auth session generation: advances on logout and whenever a new
  // authenticated session starts (login/adoptTokens). A /me captured under an
  // older generation is stale even when the SUBJECT matches — logout plus
  // relogin as the same user is still a new session. Token refresh does not
  // advance it (same session, only the raw token changed).
  const sessionGenRef = useRef(0);
  // Monotonic /me request-start identity. Each loadMe captures its id AND the
  // selected-org identity at request start; a successful live confirmation
  // records {requestId, requestStartOrg, settledOrg}. selectOrganization
  // captures a watermark before its optimistic write, so a "concurrent /me
  // already confirmed the target" shortcut can require a confirmation whose
  // REQUEST BEGAN after this attempt — a pre-attempt refresh can never
  // satisfy it, even if it resolves later and settles the mutable target.
  const meRequestIdRef = useRef(0);
  const lastLiveConfirmRef = useRef<{
    requestId: number;
    requestStartOrg: string | null;
    settledOrg: string | null;
  } | null>(null);
  // True only after an authoritative live /me snapshot was fully applied in
  // this session. An initial transport failure may still flip `meLoaded`
  // (fail-soft app shell) but leaves this false; reset on logout and every
  // new login/adopted-token session. A later refresh failure does not erase
  // an already-authoritative snapshot.
  const [meAuthoritative, setMeAuthoritative] = useState(false);
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
    clearStoredTokens();
    // New generation FIRST: any in-flight /me from the old session becomes
    // stale before its state is even considered.
    sessionGenRef.current += 1;
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
    selectedOrgIdRef.current = null;
    confirmedOrgIdRef.current = null;
    setOnboardingStep(null);
    setOnboardingDismissedAt(null);
    setOnboardingCompletedAt(null);
    setDocsEnabled(false);
    setMeLoaded(false);
    setMeAuthoritative(false);
    setSwitchingOrg(null);
  }, [queryClient]);

  const loadMe = useCallback(async () => {
    // Throws on transport failure. `fetchMe` wraps this with the fail-soft
    // catch for initial load / manual refresh; `selectOrganization` consumes
    // the rejection directly because the post-switch /me is the switch's
    // confirmation authority.
    const generation = sessionGenRef.current;
    const subject = userIdFromToken();
    const requestId = ++meRequestIdRef.current;
    const requestStartOrg = selectedOrgIdRef.current;
    try {
      const data = await api.get<MeResponse>("/me");
      // A stale SUCCESS must mutate nothing: the session moved on (logout,
      // login/adoptTokens — even with the same subject) or the identity
      // changed. Checked before ANY React state, ref, localStorage, API-org
      // override, cache, or WS write. Concurrent same-session requests are
      // deliberately NOT sequenced here — they carry the same session's
      // authoritative snapshot, and a global /me scheduler is out of scope.
      if (generation !== sessionGenRef.current || userIdFromToken() !== subject) {
        throw new StaleMeError();
      }
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
      // last-used org — survives logout so a returning user lands back in the
      // org they left — then (3) /me's `defaultOrganizationId` (most-recent),
      // (4) the first active membership. A successful /me is the ONLY place
      // the confirmed-org baseline advances.
      const userId = data.user?.id ?? null;
      const prev = selectedOrgIdRef.current;
      const isMember = (id: string | null): id is string => !!id && ms.some((m) => m.organizationId === id);
      const prevValid = isMember(prev) ? prev : null;
      const stored = readSelectedOrgId(userId);
      const storedValid = isMember(stored) ? stored : null;
      const settled = prevValid ?? storedValid ?? data.defaultOrganizationId ?? ms[0]?.organizationId ?? null;
      selectedOrgIdRef.current = settled;
      confirmedOrgIdRef.current = settled;
      writeSelectedOrgId(userId, settled);
      setApiSelectedOrganizationId(settled);
      setSelectedOrgId(settled);
      // The authoritative snapshot is fully applied — record the live
      // confirmation with its request-start identity (a pre-attempt request
      // can never satisfy a later switch's confirmation shortcut) and mark
      // this session's /me authority as established.
      lastLiveConfirmRef.current = { requestId, requestStartOrg, settledOrg: settled };
      setMeAuthoritative(true);
    } finally {
      // Flip the gate only for the LIVE session (generation + subject,
      // matching the success guard) — a request discarded for identity
      // mismatch must not re-open the dashboard after a logout/new-session
      // takeover. The gate still flips on ordinary same-session errors so
      // RequireAuth doesn't hang the dashboard forever if /me is briefly
      // unreachable.
      if (generation === sessionGenRef.current && userIdFromToken() === subject) setMeLoaded(true);
    }
  }, []);

  const fetchMe = useCallback(async () => {
    // Initial load and manual refreshes stay fail-soft: if /me fails, the UI
    // falls back to hiding admin features.
    try {
      await loadMe();
    } catch {
      // Swallowed by design for non-switch reads.
    }
  }, [loadMe]);

  const login = useCallback(
    async (username: string, password: string) => {
      const tokens = await loginApi(username, password);
      // A new authenticated session starts — even for the same subject.
      sessionGenRef.current += 1;
      setMeAuthoritative(false);
      setStoredTokens({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe],
  );

  const adoptTokens = useCallback(
    async (tokens: { accessToken: string; refreshToken: string }) => {
      // A new authenticated session starts — even for the same subject.
      sessionGenRef.current += 1;
      setMeAuthoritative(false);
      setStoredTokens(tokens);
      setIsAuthenticated(true);
      await fetchMe();
    },
    [fetchMe],
  );

  const selectOrganization = useCallback(
    async (organizationId: string) => {
      // The post-switch /me confirms the switch. Capture the session
      // generation, the subject marker, the last CONFIRMED org (never the
      // optimistic target), and the /me request watermark up front.
      const sessionGeneration = sessionGenRef.current;
      const sessionMarker = userIdFromToken();
      const previousOrgId = confirmedOrgIdRef.current;
      const attemptRequestWatermark = meRequestIdRef.current;
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
      selectedOrgIdRef.current = organizationId;
      setSelectedOrgId(organizationId);
      try {
        await loadMe();
      } catch (error) {
        // Session moved on mid-flight — logout (a final-401 clears tokens and
        // dispatches auth:logout BEFORE throwing), a new login/adoptTokens,
        // or an identity change. Logout / the new session owns the final
        // state: reject WITHOUT rolling anything back into it. The marker
        // pair (generation + subject) means an ordinary token refresh
        // mid-switch does not masquerade as an identity change, while
        // logout + relogin as the same subject still counts as a new session.
        if (sessionGenRef.current !== sessionGeneration || userIdFromToken() !== sessionMarker) throw error;
        // Only a live /me whose REQUEST BEGAN after this attempt — and whose
        // request-start and settled targets both equal the exact Team — can
        // satisfy this switch (e.g. a manual refresh that started after the
        // optimistic write and confirmed the target). A refresh begun BEFORE
        // the attempt never satisfies it, even when it resolves later and
        // happens to settle the mutable target; a pre-existing confirmed org
        // never turns a new failed request into success.
        const confirm = lastLiveConfirmRef.current;
        if (
          confirm &&
          confirm.requestId > attemptRequestWatermark &&
          confirm.requestStartOrg === organizationId &&
          confirm.settledOrg === organizationId
        ) {
          return;
        }
        // Ordinary transport failure within the SAME live session: /me never
        // confirmed the target, so roll back the React selection, the
        // per-user persisted org, the API override, the admin WS target, and
        // the HIDDEN rollback baseline — a rejected pre-attempt response is
        // not authority for this switch and must not survive as the next
        // attempt's `previousOrgId`. Also drop anything cached against the
        // unconfirmed target during the optimistic window. The rejection
        // lets the caller surface a recoverable error.
        selectedOrgIdRef.current = previousOrgId;
        confirmedOrgIdRef.current = previousOrgId;
        writeSelectedOrgId(userIdFromToken(), previousOrgId);
        setApiSelectedOrganizationId(previousOrgId);
        window.dispatchEvent(new CustomEvent(ADMIN_WS_ORG_CHANGED_EVENT));
        queryClient.clear();
        setSelectedOrgId(previousOrgId);
        throw error;
      }
    },
    [loadMe, queryClient],
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
    // on the very next render. The server stamp is canonical. Roll the local
    // projection back and propagate failures so terminal flows without an
    // already-created chat can remain on-screen and retry.
    const organizationId = currentMembership?.organizationId;
    const priorAccountCompletedAt = onboardingCompletedAt;
    const priorAccountDismissedAt = onboardingDismissedAt;
    const priorMembershipCompletedAt = currentMembership?.onboardingCompletedAt ?? null;
    const priorMembershipSuppressedAt = currentMembership?.onboardingSuppressedAt ?? null;
    const priorMembershipSuppressedReason = currentMembership?.onboardingSuppressedReason ?? null;
    const optimistic = new Date().toISOString();
    setOnboardingCompletedAt((prev) => prev ?? optimistic);
    setOnboardingDismissedAt((prev) => prev ?? optimistic);
    patchMembershipOnboarding({
      onboardingCompletedAt: currentMembership?.onboardingCompletedAt ?? optimistic,
      onboardingSuppressedAt: currentMembership?.onboardingSuppressedAt ?? optimistic,
      onboardingSuppressedReason: "completed",
    });
    try {
      await postOnboardingCompleted(organizationId ?? undefined);
    } catch (error) {
      setOnboardingCompletedAt(priorAccountCompletedAt);
      setOnboardingDismissedAt(priorAccountDismissedAt);
      patchMembershipOnboarding({
        onboardingCompletedAt: priorMembershipCompletedAt,
        onboardingSuppressedAt: priorMembershipSuppressedAt,
        onboardingSuppressedReason: priorMembershipSuppressedReason,
      });
      throw error;
    }
  }, [
    onboardingCompletedAt,
    onboardingDismissedAt,
    currentMembership?.onboardingCompletedAt,
    currentMembership?.onboardingSuppressedAt,
    currentMembership?.onboardingSuppressedReason,
    currentMembership?.organizationId,
    patchMembershipOnboarding,
  ]);

  const applyOnboardingKickoffStamp = useCallback(
    (stamp: "completed" | "invitee_skip") => {
      const stampedAt = new Date().toISOString();
      setOnboardingDismissedAt((prev) => prev ?? stampedAt);
      if (stamp === "completed") {
        setOnboardingCompletedAt((prev) => prev ?? stampedAt);
        patchMembershipOnboarding({
          onboardingCompletedAt: currentMembership?.onboardingCompletedAt ?? stampedAt,
          onboardingSuppressedAt: currentMembership?.onboardingSuppressedAt ?? stampedAt,
          onboardingSuppressedReason: "completed",
        });
        return;
      }
      patchMembershipOnboarding({
        onboardingSuppressedAt: currentMembership?.onboardingSuppressedAt ?? stampedAt,
        onboardingSuppressedReason: currentMembership?.onboardingSuppressedReason ?? "invitee_skip",
      });
    },
    [
      currentMembership?.onboardingCompletedAt,
      currentMembership?.onboardingSuppressedAt,
      currentMembership?.onboardingSuppressedReason,
      patchMembershipOnboarding,
    ],
  );

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

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        meLoaded,
        meAuthoritative,
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
        applyOnboardingKickoffStamp,
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
