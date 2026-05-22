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
 *                 the AI teammate, and kick off the first task.
 *   - "invitee" — joining a team an admin has already set up. Skips the
 *                 team + code steps (the team already owns those) and just
 *                 connects a computer, creates their teammate, and starts.
 *
 * Step ids are deliberately product-facing, jargon-free concepts — never
 * "tree" / "binding" / "runtime" / "installation". The user-facing strings
 * live in copy.ts.
 */

export const ADMIN_STEPS = ["team", "connect-code", "connect-computer", "create-agent", "kickoff"] as const;
export const INVITEE_STEPS = ["welcome", "connect-computer", "create-agent", "kickoff"] as const;

export type AdminStepId = (typeof ADMIN_STEPS)[number];
export type InviteeStepId = (typeof INVITEE_STEPS)[number];
export type StepId = AdminStepId | InviteeStepId;

export type OnboardingPath = "admin" | "invitee";

/** Server-inferred coarse onboarding state from `/me` (see api/me.ts). */
export type ServerOnboardingStep = "connect" | "create_agent" | "completed" | null;

export type StepVisualState = "complete" | "active" | "pending";

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
 *   - `completed` (client + agent both exist) → the final kickoff step
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
  if (facts.onboardingStep === "completed") return seq.indexOf("kickoff");
  if (facts.onboardingStep === "create_agent") return seq.indexOf("create-agent");
  // "connect" or null — no computer connected yet.
  if (path === "admin") {
    return facts.teamSettled ? seq.indexOf("connect-code") : 0;
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

/**
 * Visual state for the stepper pip at `index`, given the active index.
 * The flow is a linear wizard: everything before the cursor is done,
 * everything after is not yet reachable.
 */
export function stepVisualState(index: number, activeIndex: number): StepVisualState {
  if (index < activeIndex) return "complete";
  if (index === activeIndex) return "active";
  return "pending";
}

export type OnboardingGateFacts = {
  /** `false` until `/me` has resolved at least once. */
  meLoaded: boolean;
  onboardingStep: ServerOnboardingStep;
  onboardingDismissedAt: string | null;
  onboardingCompletedAt: string | null;
};

/**
 * Should the workspace root (`/`) bounce an authenticated user into the
 * standalone onboarding flow?
 *
 * Yes only when the user hasn't finished the *resource* setup yet — they
 * have no AI teammate (server step `connect` or `create_agent`) — and they
 * haven't completed or hidden onboarding.
 *
 * We deliberately do NOT bounce a server-`completed` user (one who already
 * has a computer + an agent). Two reasons:
 *   - A brand-new user reaches the final kickoff step via in-flow state
 *     (create-agent advances to it); if they leave early, Settings → Setup
 *     resumes it. The `/` gate doesn't need to drag them back.
 *   - An existing, already-onboarded user must never be yanked into the
 *     wizard on deploy just because they predate the `completed_at` stamp
 *     (their server step is `completed` but the column was never written).
 */
export function shouldEnterOnboarding(facts: OnboardingGateFacts): boolean {
  if (!facts.meLoaded) return false;
  if (facts.onboardingCompletedAt) return false;
  if (facts.onboardingDismissedAt) return false;
  return facts.onboardingStep === "connect" || facts.onboardingStep === "create_agent";
}

/**
 * Should the `/onboarding` route bounce the user back to the workspace?
 *
 * Only once setup is terminally complete — so a finished user can't get
 * stranded on the wizard, while a still-incomplete (or merely dismissed,
 * but deliberately returning via "Resume") user is allowed to stay and
 * work through it.
 */
export function shouldLeaveOnboarding(facts: OnboardingGateFacts): boolean {
  if (!facts.meLoaded) return false;
  return facts.onboardingCompletedAt !== null;
}

/**
 * Which invitee kickoff sub-state to show, given what the team has set up.
 * Pure so it's unit-testable (the React component just maps the result to a
 * body):
 *   - no team knowledge link yet            → "waiting" (admin isn't done)
 *   - link + the team listed its projects   → "confirm" (pick from them)
 *   - link but no team projects listed      → "picker"  (invitee picks own)
 */
export type InviteeKickoffState = "waiting" | "confirm" | "picker";

export function resolveInviteeKickoffState(args: { treeUrl: string; teamRepoCount: number }): InviteeKickoffState {
  if (!args.treeUrl) return "waiting";
  return args.teamRepoCount > 0 ? "confirm" : "picker";
}
