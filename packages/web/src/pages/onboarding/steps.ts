/**
 * Pure logic for the standalone `/onboarding` flow.
 *
 * The React layer (onboarding-page.tsx) stays thin: it owns side effects
 * (API calls, navigation) and renders the active step. Every *decision* —
 * which path the user is on, which step is active, whether to redirect in
 * or out of the flow — lives here as a pure function so it can be unit
 * tested without a DOM (matching this package's `.test.ts` convention).
 *
 * Two paths:
 *   - "admin"   — the team creator (org admin). Creates/confirms the team,
 *                 connects a computer, creates the agent, and starts chat.
 *   - "invitee" — joining an existing team. Skips team-wide GitHub / Context
 *                 Tree setup, connects a computer, creates their teammate, and
 *                 starts chat.
 *
 * Step ids are deliberately product-facing, jargon-free concepts — never
 * "tree" / "binding" / "runtime" / "installation". The user-facing strings
 * live in copy.ts.
 */

// There is intentionally no GitHub-connect ("connect-code") step in either
// sequence: the value-first redesign moved code connection off the onboarding
// critical path so the user reaches their agent first (GitHub access happens
// later, from Settings or when a task needs it). The `StepConnectCode` component
// is KEPT (preview + Context-tab tree build entry) and may be re-added to a
// sequence here later — see its retention note. Until then nothing in the live
// flow populates `selectedRepoUrls`, so the repo-aware branches downstream
// (e.g. the `hasRepos` path in step-start-chat.tsx) stay dormant by design.
export const ADMIN_STEPS = ["create-team", "connect-computer", "create-agent", "start-chat"] as const;
export const INVITEE_STEPS = ["join-team", "connect-computer", "create-agent", "start-chat"] as const;

/**
 * Prominent setup progress intentionally stops at agent readiness. `start-chat`
 * remains a real flow state because it creates the first chat and stamps
 * completion, but it is the payoff screen after setup rather than a fourth
 * configuration chore in the progress bar.
 */
export const ADMIN_PROGRESS_STEPS = ["create-team", "connect-computer", "create-agent"] as const;
export const INVITEE_PROGRESS_STEPS = ["join-team", "connect-computer", "create-agent"] as const;
export const ADMIN_CONFIG_STEPS = ["connect-computer", "create-agent"] as const;
export const INVITEE_CONFIG_STEPS = ["connect-computer", "create-agent"] as const;

export type AdminStepId = (typeof ADMIN_STEPS)[number];
export type InviteeStepId = (typeof INVITEE_STEPS)[number];
export type StepId = AdminStepId | InviteeStepId;

export type OnboardingPath = "admin" | "invitee";

/** Server-inferred coarse onboarding state from `/me` (see api/me.ts). */
export type ServerOnboardingStep = "connect" | "create_agent" | "completed" | null;

/**
 * Resolve which path the user is on. The team creator is the org admin; a
 * member who was invited into an already-created team takes the lighter
 * invitee path. This mirrors the role split the legacy Step 3 used
 * (`role === "admin"` → admin body, else invitee body) so behaviour is
 * unchanged for existing accounts — only the surface around it differs.
 */
export function resolveOnboardingPath(role: string | null): OnboardingPath {
  return role === "admin" ? "admin" : "invitee";
}

/** The ordered step ids for a path. */
export function getStepSequence(path: OnboardingPath): readonly StepId[] {
  return path === "admin" ? ADMIN_STEPS : INVITEE_STEPS;
}

export type InitialStepFacts = {
  onboardingStep: ServerOnboardingStep;
  /**
   * `true` when the team no longer carries its auto-generated default name,
   * OR the user already confirmed the team step this session. Retained for
   * callers and tests only — `inferInitialStepIndex` no longer consults it:
   * a fresh entry always lands on the opening step regardless of readiness.
   */
  teamSettled: boolean;
};

/**
 * Pick the step to land on when the page first mounts (or the user reloads
 * mid-flow). Fresh entries always start at the opening product step:
 *
 *   - admin   → create-team
 *   - invitee → join-team
 *
 * Server facts still decide whether `/` enters onboarding at all, but once the
 * user is in the standalone flow the prominent setup journey should begin at
 * the first milestone. Same-tab progress is restored separately from the
 * per-org persisted step index in onboarding-flow.tsx.
 */
export function inferInitialStepIndex(path: OnboardingPath, facts: InitialStepFacts): number {
  void facts;
  return path === "admin" ? ADMIN_STEPS.indexOf("create-team") : INVITEE_STEPS.indexOf("join-team");
}

/** Clamp an arbitrary index into the path's valid range. */
export function clampStepIndex(path: OnboardingPath, index: number): number {
  const last = getStepSequence(path).length - 1;
  if (index < 0) return 0;
  if (index > last) return last;
  return index;
}

/** The setup-only subset, kept for analytics/copy that needs chore counts. */
export function getConfigSteps(path: OnboardingPath): readonly StepId[] {
  return path === "admin" ? ADMIN_CONFIG_STEPS : INVITEE_CONFIG_STEPS;
}

/** The steps shown in the prominent setup progress bar. */
export function getProgressSteps(path: OnboardingPath): readonly StepId[] {
  return path === "admin" ? ADMIN_PROGRESS_STEPS : INVITEE_PROGRESS_STEPS;
}

export type StepProgress = {
  /** 0-based position of the active step among the visible journey steps. */
  index: number;
  /** How many visible journey steps this path has. */
  total: number;
};

/**
 * Where `step` sits in the prominent setup progress bar. `start-chat` returns
 * null so the final launch screen reads as the result of setup, not another
 * setup chore.
 */
export function resolveStepProgress(path: OnboardingPath, step: StepId): StepProgress | null {
  const steps = getProgressSteps(path);
  const index = steps.indexOf(step);
  if (index < 0) return null;
  return { index, total: steps.length };
}

export type OnboardingGateFacts = {
  /** `false` until `/me` has resolved at least once. */
  meLoaded: boolean;
  /**
   * Account-level server step from `/me`. Only its `connect` / `null` value
   * is consulted here — it tells us whether the user has connected a runtime
   * client yet (a once-per-account step). The `create_agent` / `completed`
   * distinction is org-specific and comes from `currentOrgHasPersonalAgent`
   * instead.
   */
  onboardingStep: ServerOnboardingStep;
  /**
   * Whether the *currently selected* membership manages an active non-human
   * agent in this org — `auth.currentOrgHasPersonalAgent`. Replaces the old
   * "usable" readiness so a returning user joining a mature team with another
   * member's shared org-visible agent still creates their own personal agent.
   */
  currentOrgHasPersonalAgent: boolean;
  onboardingSuppressedAt: string | null;
  /**
   * The *currently selected* membership's completion stamp
   * (`auth.onboardingCompletedAt`, resolved per-membership) — non-null only
   * once the start-chat/completion path has run for THIS org. `shouldLeaveOnboarding`
   * gates the `/onboarding` → `/` bounce on it; `shouldEnterOnboarding` ignores
   * it (the `/` auto-entry gate keys off connect + org readiness only, never
   * completion — start-chat is not an auto-entry predicate).
   */
  onboardingCompletedAt: string | null;
};

/**
 * Should the workspace root (`/`) bounce an authenticated user into the
 * standalone onboarding flow?
 *
 * Two independent gates, in order:
 *   1. Account-level — the user hasn't connected a runtime client yet
 *      (server step `connect` / null). Connecting a computer is a
 *      once-per-account step, so this is judged user-wide.
 *   2. Membership-level — they're connected, but the selected membership has
 *      no personal agent in this org (`!currentOrgHasPersonalAgent`). This is
 *      what makes a returning, already-onboarded user still get walked through
 *      create-agent when they join another team, even if that team has shared
 *      org-visible agents.
 *
 * A membership that already suppressed auto-open (finish later, invitee skip,
 * or normal completion) is never bounced. Note there is deliberately no
 * account-level "completed" escape hatch anymore — readiness is always
 * evaluated against the current org.
 */
export function shouldEnterOnboarding(facts: OnboardingGateFacts): boolean {
  if (!facts.meLoaded) return false;
  if (facts.onboardingSuppressedAt) return false;
  // A null step means /me hasn't reported one (e.g. a transient failure after
  // meLoaded flipped) — don't bounce on incomplete data.
  if (facts.onboardingStep === null) return false;
  // (1) No runtime client connected yet → start at "connect a computer".
  if (facts.onboardingStep === "connect") return true;
  // (2) Connected, but this membership has no personal agent → create one here.
  if (!facts.currentOrgHasPersonalAgent) return true;
  return false;
}

/**
 * Should the `/onboarding` route bounce the user back to the workspace?
 *
 * Only once the selected org's onboarding is terminally done: the user is
 * connected, the org has a personal agent, AND this membership carries its
 * completion stamp (`onboardingCompletedAt`). The stamp is the load-bearing
 * gate. Creating the agent flips `currentOrgHasPersonalAgent` true and makes
 * the server infer `onboardingStep="completed"` the instant the agent comes
 * online, but both paths still have start-chat ahead.
 * The in-page leave decision is frozen in a ref so an active session isn't
 * ejected mid-flow, yet a full page reload builds a fresh component that
 * recomputes from `/me`; without the completion gate that reload bounces the
 * user out before those steps finish. Only the start-chat/completion path writes
 * the stamp, so gating on it keeps a reloaded user in the flow until setup is
 * genuinely finished.
 *
 * A user still on `connect`, in an org without a personal agent, or in an org
 * whose membership has not been stamped complete is allowed to stay and work
 * through the wizard (including a "finish later"-dismissed user who returned
 * via "Resume"). They leave via the explicit completion / finish-later
 * navigate, never an entry-time bounce.
 */
export function shouldLeaveOnboarding(facts: OnboardingGateFacts): boolean {
  if (!facts.meLoaded) return false;
  if (facts.onboardingStep === "connect" || facts.onboardingStep === null) return false;
  if (!facts.currentOrgHasPersonalAgent) return false;
  return facts.onboardingCompletedAt !== null;
}

/**
 * Whether the connect-computer wall may offer the install-free team-agent
 * start: begin working in a teammate's org-visible agent chat now, and finish
 * the standard connect-computer → create-agent setup later.
 *
 * Offered only while BOTH hold:
 *   - the selected org has a usable agent this member did not create
 *     (`currentOrgHasUsableAgent` can include org-visible agents owned by
 *     another member — a fresh solo team never qualifies), and
 *   - this membership still has no personal agent (once it does, the standard
 *     journey is nearly done and the shortcut would only confuse).
 *
 * Deliberately not path-gated: the admin creating a brand-new team can never
 * satisfy the usable-agent condition, so the predicate self-selects joining
 * members without hard-coding path.
 */
export function canOfferTeamAgentStart(facts: {
  currentOrgHasUsableAgent: boolean;
  currentOrgHasPersonalAgent: boolean;
}): boolean {
  return facts.currentOrgHasUsableAgent && !facts.currentOrgHasPersonalAgent;
}

/**
 * Which invitee start-chat state to show, given what the team has set up. Just two:
 *   - "ready"     → the team has BOTH a Context Tree and a GitHub connection;
 *                   the agent can do real work, so launch.
 *   - "not-ready" → either is missing. We don't distinguish "no tree" from "no
 *                   GitHub": in both cases the invitee is blocked on the admin
 *                   and can't act on it, so a single screen ("your team is still
 *                   setting up" + a simple first-chat action) covers both. The
 *                   start-chat query keeps polling, so this flips to "ready" on its
 *                   own the moment the admin finishes whichever half was missing.
 *
 * Pure so it's unit-testable (the React component just maps the result to a
 * body). There is no repo-selection state: the invitee's agent inherits the
 * team's `recommended` repo resources automatically (enabled for every org
 * agent), so there was never anything to pick here.
 */
export type InviteeStartChatState = "ready" | "not-ready";

export function resolveInviteeStartChatState(args: {
  treeUrl: string;
  hasInstallation: boolean;
}): InviteeStartChatState {
  return args.treeUrl && args.hasInstallation ? "ready" : "not-ready";
}
