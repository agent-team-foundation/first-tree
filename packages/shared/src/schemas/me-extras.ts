import { z } from "zod";

/**
 * Inferred onboarding step returned by `GET /me`. The server derives this
 * from live `clients` / `agents` rows on every request — no persisted
 * `members.onboarding_state` column. The advantage is that deleting the
 * client or the first agent automatically rewinds onboarding, so the UI
 * always reflects truth-on-the-ground rather than a snapshot.
 */
export const onboardingStepSchema = z.enum(["connect", "create_agent", "completed"]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

/** Brief org descriptor returned to onboarding / the org switcher. */
export const orgBriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  displayName: z.string(),
  role: z.enum(["admin", "member"]),
});
export type OrgBrief = z.infer<typeof orgBriefSchema>;

/** Body for `POST /me/organizations` — operator wants to create another team. */
export const createOrgFromMeSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(50)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  displayName: z.string().min(1).max(200),
});
export type CreateOrgFromMe = z.infer<typeof createOrgFromMeSchema>;

/**
 * Body for `PATCH /me/onboarding`. `dismissed=true` is the "finish later"
 * action: it suppresses future auto-open for the selected membership only.
 */
export const patchOnboardingSchema = z.object({
  dismissed: z.boolean().optional(),
  organizationId: z.string().optional(),
});
export type PatchOnboarding = z.infer<typeof patchOnboardingSchema>;

/** Body for `POST /me/onboarding-completed`. */
export const completeOnboardingSchema = z.object({
  organizationId: z.string().optional(),
});
export type CompleteOnboarding = z.infer<typeof completeOnboardingSchema>;

/**
 * Discriminates *which* kickoff this is for the same (human, agent) pair, so the
 * idempotency key doesn't conflate distinct intents:
 *   - "intro" — "meet your agent" with no tree work (admin connected no repo,
 *     or an invitee launching while the team isn't set up yet).
 *   - "work"  — wake the agent for the value-first first chat: read the repo /
 *     team context, show concrete understanding, and ask the user to pick a
 *     first useful task.
 *   - "tree"  — wake the agent to seed/read the team's Context Tree (admin with
 *     repos AND the `/build-tree` recovery surface). It is intentionally
 *     separate from "work" so heavy tree setup can run in its own chat.
 *
 * Without this, an admin who first does an "intro" kickoff and later runs
 * `/build-tree` with the same agent would resolve to the intro chat, and the
 * send-if-empty guard would skip the tree-seeding bootstrap — the UI completes
 * but the agent is never woken to build the tree.
 */
export const kickoffKindSchema = z.enum(["intro", "work", "tree"]);
export type KickoffKind = z.infer<typeof kickoffKindSchema>;

/**
 * Body for `POST /me/onboarding/kickoff` — the idempotent server-side chat
 * creation/send tail of onboarding. Callers decide whether this kickoff should
 * stamp completion after the chat exists; background/support chats can pass
 * `complete: false`.
 *
 * `agentUuid` is the bootstrap agent the chat is opened with. `bootstrap` is
 * the first message body. `kind` separates the intro vs tree-building intents
 * (see `kickoffKindSchema`). `organizationId` scopes the membership whose
 * completion is stamped (defaults to the caller's default membership).
 */
export const kickoffOnboardingSchema = z.object({
  organizationId: z.string().optional(),
  agentUuid: z.string().min(1),
  bootstrap: z.string().min(1),
  kind: kickoffKindSchema,
  complete: z.boolean().optional(),
});
export type KickoffOnboarding = z.infer<typeof kickoffOnboardingSchema>;

/** Response for `POST /me/onboarding/kickoff` — the (stable) kickoff chat id. */
export const kickoffOnboardingResultSchema = z.object({
  chatId: z.string(),
});
export type KickoffOnboardingResult = z.infer<typeof kickoffOnboardingResultSchema>;

/**
 * Body for `POST /me/onboarding/events`. The web SPA reports key
 * milestones so the server can log them as a single funnel-trackable
 * stream alongside server-emitted events (`team_created`, `dismissed`).
 *
 * Server emits:
 *   - `team_created`           — at OAuth callback when joinPath === "solo"
 *   - `dismissed`              — when PATCH /me/onboarding flips dismissed
 *
 * Web reports:
 *   - `team_renamed`           — Step 1 user changed the auto-named team
 *   - `agent_created`          — Step 2 successfully created the agent
 *   - `kickoff_chat_started`   — an intro/work/tree kickoff chat was created
 *   - `tree_chat_started`      — legacy name for the Step 3 tree kickoff event
 *   - `tree_intro_dismissed`   — Step 3 [I'll do it later] clicked
 */
export const onboardingEventNameSchema = z.enum([
  "team_renamed",
  "agent_created",
  "kickoff_chat_started",
  "tree_chat_started",
  "tree_intro_dismissed",
]);
export type OnboardingEventName = z.infer<typeof onboardingEventNameSchema>;

export const onboardingEventSchema = z.object({
  event: onboardingEventNameSchema,
  attrs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type OnboardingEvent = z.infer<typeof onboardingEventSchema>;

/**
 * One element of `GET /me memberships`. Powers the web client's
 * `currentMembership` derivation (decouple-client-from-identity §C1).
 * `agentId` is the human-agent UUID seeded for the user in that org —
 * the web admin gate keys off it.
 *
 * `orgHasOtherMembers` is true when the org has at least one other active
 * member besides the caller (`COUNT(members WHERE status='active') > 1`).
 * The web onboarding flow uses this to derive "is this a solo team or a
 * team-of-teammates" without relying on the per-tab `joinPath` flag, which
 * can be lost on a different tab / device mid-onboarding.
 *
 * `hasUsableAgent` is true when this member can use a non-human agent in
 * that org — one they manage themselves OR one another member set to
 * `visibility="organization"`. This is the general product availability bit
 * for team/chat surfaces; it is not sufficient to complete onboarding because
 * a joining member still needs their own personal agent.
 *
 * `hasPersonalAgent` is true when this membership manages at least one active
 * non-human agent in the org. Onboarding uses this own-agent readiness bit for
 * the create-agent step so a returning user who joins a mature team with a
 * shared org-visible agent still creates their own teammate before kickoff.
 */
export const meMembershipSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  role: z.enum(["admin", "member"]),
  agentId: z.string(),
  orgHasOtherMembers: z.boolean(),
  hasUsableAgent: z.boolean(),
  hasPersonalAgent: z.boolean(),
  onboardingSuppressedAt: z.string().nullable(),
  onboardingSuppressedReason: z.enum(["finish_later", "completed", "invitee_skip"]).nullable(),
  onboardingCompletedAt: z.string().nullable(),
});
export type MeMembership = z.infer<typeof meMembershipSchema>;
