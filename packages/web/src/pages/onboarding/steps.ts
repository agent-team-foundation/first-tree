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
   * distinction is org-specific and comes from `currentOrgReady` instead.
   */
  onboardingStep: ServerOnboardingStep;
  /**
   * Whether the *currently selected* org has a non-human agent this member
   * can use (own or org-visible) — `auth.currentOrgHasUsableAgent`. Replaces
   * the old account-level `onboardingCompletedAt` short-circuit so a
   * returning user joining a brand-new / all-private org is still routed
   * through create-agent for that org.
   */
  currentOrgReady: boolean;
  onboardingDismissedAt: string | null;
};

/**
 * Should the workspace root (`/`) bounce an authenticated user into the
 * standalone onboarding flow?
 *
 * Two independent gates, in order:
 *   1. Account-level — the user hasn't connected a runtime client yet
 *      (server step `connect` / null). Connecting a computer is a
 *      once-per-account step, so this is judged user-wide.
 *   2. Org-level — they're connected, but the *selected* org has no agent
 *      they can use (`!currentOrgReady`). This is what makes a returning,
 *      already-onboarded user still get walked through create-agent when
 *      they join a brand-new or all-private org.
 *
 * A user who explicitly dismissed onboarding ("finish later") is never
 * bounced. Note there is deliberately no account-level "completed" escape
 * hatch anymore — readiness is always evaluated against the current org.
 */
export function shouldEnterOnboarding(facts: OnboardingGateFacts): boolean {
  if (!facts.meLoaded) return false;
  if (facts.onboardingDismissedAt) return false;
  // A null step means /me hasn't reported one (e.g. a transient failure after
  // meLoaded flipped) — don't bounce on incomplete data.
  if (facts.onboardingStep === null) return false;
  // (1) No runtime client connected yet → start at "connect a computer".
  if (facts.onboardingStep === "connect") return true;
  // (2) Connected, but this org has no usable agent → "create an agent" here.
  if (!facts.currentOrgReady) return true;
  return false;
}

/**
 * Should the `/onboarding` route bounce the user back to the workspace?
 *
 * Once there is nothing left to set up *for the selected org*: the user is
 * connected AND the org has a usable agent. A user still on `connect`, or in
 * an org without a usable agent, is allowed to stay and work through the
 * wizard (including a "finish later"-dismissed user who deliberately
 * returned via "Resume"). Mirror image of `shouldEnterOnboarding` minus the
 * dismiss escape hatch, so the two can't fight over the same user.
 */
export function shouldLeaveOnboarding(facts: OnboardingGateFacts): boolean {
  if (!facts.meLoaded) return false;
  if (facts.onboardingStep === "connect" || facts.onboardingStep === null) return false;
  return facts.currentOrgReady;
}

/**
 * Which invitee kickoff sub-state to show, given what the team has set up.
 * Pure so it's unit-testable (the React component just maps the result to a
 * body). Ordered upstream-first — fix the biggest blocker before launch:
 *   - no Context Tree link yet            → "waiting"          (admin isn't done at all)
 *   - link but no GitHub App installation → "no-installation"  (admin skipped code; agent would 403)
 *   - link + install                      → "ready"            (just launch)
 *
 * There is deliberately no repo-selection sub-state. The invitee's agent
 * inherits the team's `recommended` repo resources automatically (they're
 * enabled for every org agent), so picking repos here changed nothing about
 * what the agent could access — it only flavoured the kickoff message. The
 * "ready" state is a pure launch; the body names the team's repos when there
 * are any, otherwise frames it as an intro.
 *
 * The "no-installation" state exists because the previous flow silently
 * advanced invitees past it, where the agent's first git op would 403. We
 * hold there instead, with a "Meet your agent" bailout so the invitee is
 * never truly blocked.
 */
export type InviteeKickoffState = "waiting" | "no-installation" | "ready";

export function resolveInviteeKickoffState(args: { treeUrl: string; hasInstallation: boolean }): InviteeKickoffState {
  if (!args.treeUrl) return "waiting";
  if (!args.hasInstallation) return "no-installation";
  return "ready";
}
