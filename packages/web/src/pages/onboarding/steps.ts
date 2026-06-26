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
 *   - "admin"   — the team creator (org admin). Walks the full ceremony:
 *                 name the team, connect code, connect a computer, create
 *                 the agent, and kick off the first task.
 *   - "invitee" — joining a team an admin has already set up. Skips the
 *                 team + code steps (the team already owns those) and just
 *                 connects a computer, creates their teammate, and starts.
 *
 * Step ids are deliberately product-facing, jargon-free concepts — never
 * "tree" / "binding" / "runtime" / "installation". The user-facing strings
 * live in copy.ts.
 */

export const ADMIN_STEPS = ["team", "connect-computer", "create-agent", "connect-code", "kickoff"] as const;
export const INVITEE_STEPS = ["welcome", "connect-computer", "create-agent", "kickoff"] as const;

/**
 * The subset of steps the progress indicator actually tracks: the real
 * hands-on configuration work. The opening step (`team` / `welcome`) and the
 * closing `kickoff` are journey *bookends* — an orientation page and a
 * completion celebration, not tasks — so they're deliberately excluded.
 *
 * Why this matters for the indicator: counting "name your team" or "say hello
 * and start" as steps reads them as chores and reinflates the task-list
 * pressure the wizard is trying to shed. With the bookends dropped the bar
 * shows admin 3 / invitee 2 — small enough that "how much is left" stops being
 * a source of anxiety. The bookends still render full screens; they just don't
 * carry a progress bar (the opening page previews the journey in prose
 * instead, the celebration page stays rail-free for a cleaner finish).
 */
export const ADMIN_CONFIG_STEPS = ["connect-computer", "create-agent", "connect-code"] as const;
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
   * OR the user already confirmed the team step this session. Lets a
   * returning admin skip straight past "name your team".
   */
  teamSettled: boolean;
};

/**
 * Pick the step to land on when the page first mounts (or the user reloads
 * mid-flow). Driven by the few facts the server can vouch for:
 *
 *   - `completed` (client + agent both exist) → admin resumes at connect-code
 *     (connect-code + kickoff are still ahead of create-agent); invitee at kickoff
 *   - `create_agent` (client exists, no agent) → create the teammate
 *   - `connect` / null (no client yet) → the earliest unfinished setup step
 *
 * Finer progress (did they finish connect-code? connect-computer?) isn't
 * server-observable, so the wizard advances those locally via Continue;
 * this only needs to avoid dropping a returning user *behind* where the
 * server proves they already are.
 */
export function inferInitialStepIndex(path: OnboardingPath, facts: InitialStepFacts): number {
  const seq = getStepSequence(path);
  if (facts.onboardingStep === "completed") {
    // Server proves client + agent exist (through create-agent). For admins,
    // connect-code + kickoff are still ahead and aren't server-tracked, so
    // resume at connect-code. For invitees, kickoff is the only step left.
    return path === "admin" ? seq.indexOf("connect-code") : seq.indexOf("kickoff");
  }
  if (facts.onboardingStep === "create_agent") return seq.indexOf("create-agent");
  // "connect" or null — no computer connected yet.
  if (path === "admin") {
    return facts.teamSettled ? seq.indexOf("connect-computer") : 0;
  }
  return 0; // invitee → welcome
}

/** Clamp an arbitrary index into the path's valid range. */
export function clampStepIndex(path: OnboardingPath, index: number): number {
  const last = getStepSequence(path).length - 1;
  if (index < 0) return 0;
  if (index > last) return last;
  return index;
}

/** The config-step subset for a path (the steps the progress bar tracks). */
export function getConfigSteps(path: OnboardingPath): readonly StepId[] {
  return path === "admin" ? ADMIN_CONFIG_STEPS : INVITEE_CONFIG_STEPS;
}

export type StepProgress = {
  /** 0-based position of the active step among the config steps. */
  index: number;
  /** How many config steps this path has (3 for admin, 2 for invitee). */
  total: number;
};

/**
 * Where `step` sits in the progress bar, or `null` when it's a bookend
 * (`team` / `welcome` / `kickoff`) the bar doesn't track — the indicator
 * renders nothing on those screens. Pure so the React layer stays a thin map
 * from this result to segments + a "Step N of M" label.
 */
export function resolveStepProgress(path: OnboardingPath, step: StepId): StepProgress | null {
  const steps = getConfigSteps(path);
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
   * once the kickoff/completion path has run for THIS org. `shouldLeaveOnboarding`
   * gates the `/onboarding` → `/` bounce on it; `shouldEnterOnboarding` ignores
   * it (the `/` auto-entry gate keys off connect + org readiness only, never
   * completion — connect-code and kickoff are not auto-entry predicates).
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
 * the server infer `onboardingStep="completed"` the instant the agent comes online, but
 * the admin still has connect-code + kickoff ahead (the invitee, kickoff).
 * The in-page leave decision is frozen in a ref so an active session isn't
 * ejected mid-flow, yet a full page reload builds a fresh component that
 * recomputes from `/me`; without the completion gate that reload bounces the
 * user out before those steps finish. Only the kickoff/completion path writes
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
 * Which invitee kickoff state to show, given what the team has set up. Just two:
 *   - "ready"     → the team has BOTH a Context Tree and a GitHub connection;
 *                   the agent can do real work, so launch.
 *   - "not-ready" → either is missing. We don't distinguish "no tree" from "no
 *                   GitHub": in both cases the invitee is blocked on the admin
 *                   and can't act on it, so a single screen ("your team is still
 *                   setting up" + a "Meet your agent" bailout) covers both. The
 *                   kickoff query keeps polling, so this flips to "ready" on its
 *                   own the moment the admin finishes whichever half was missing.
 *
 * Pure so it's unit-testable (the React component just maps the result to a
 * body). There is no repo-selection state: the invitee's agent inherits the
 * team's `recommended` repo resources automatically (enabled for every org
 * agent), so there was never anything to pick here.
 */
export type InviteeKickoffState = "ready" | "not-ready";

export function resolveInviteeKickoffState(args: { treeUrl: string; hasInstallation: boolean }): InviteeKickoffState {
  return args.treeUrl && args.hasInstallation ? "ready" : "not-ready";
}
