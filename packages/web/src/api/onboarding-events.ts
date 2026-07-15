import type { OnboardingEvent, OnboardingEventName } from "@first-tree/shared";
import { api } from "./client.js";

export type StartOnboardingChatArgs = {
  organizationId?: string;
  agentUuid: string;
  bootstrap: string;
  topic?: string;
  complete?: boolean;
  /**
   * How the membership's onboarding state is stamped once the chat exists.
   * Supersedes `complete` server-side. `"invitee_skip"` is the team-agent
   * start: suppress onboarding auto-open without stamping completion, so the
   * member's own connect-computer → create-agent journey stays resumable.
   */
  stamp?: "completed" | "invitee_skip" | "none";
  /**
   * Production-scan fix conversion: `owner/repo`. When set, the server keys the
   * kickoff chat `<humanAgent>:scan-fix:<repoSlug>` so this fix launcher dedups
   * with the already-onboarded direct path instead of duplicating it.
   */
  scanFixRepoSlug?: string;
};

export type StartOnboardingChatResult = {
  chatId: string;
};

/**
 * Best-effort report of an onboarding-funnel milestone. Errors are
 * swallowed: telemetry must never break the user-facing flow.
 *
 * Server-emitted events (`team_created` at OAuth, `dismissed` on
 * stepper-✕) are NOT reported through this helper — they're logged
 * server-side directly. Use this only for the web-driven milestones
 * listed in `OnboardingEventName`.
 */
export async function reportOnboardingEvent(
  event: OnboardingEventName,
  attrs?: OnboardingEvent["attrs"],
): Promise<void> {
  try {
    await api.post<void>("/me/onboarding/events", { event, attrs });
  } catch {
    // intentionally swallowed
  }
}

/**
 * Stamp the terminal-state `onboarding_completed_at` column. Called when
 * the user walks Step 3 to success (admin Continue, invitee Confirm /
 * Continue). Once stamped, the Settings → Onboarding sidebar entry and
 * Resume button disappear permanently — Step 3 cannot be re-entered.
 *
 * Distinct from `dismissOnboarding()`, which only hides the stepper UI
 * and stays reversible via Settings → Resume. Idempotent on the server
 * (only writes when the column is still NULL). Errors are swallowed:
 * the user has already finished the wizard, so a network blip here just
 * means the sidebar entry lingers until /me refetches — not worth
 * surfacing.
 */
export async function markOnboardingCompleted(organizationId?: string): Promise<void> {
  try {
    await api.post<{ ok: true }>("/me/onboarding-completed", organizationId ? { organizationId } : {});
  } catch {
    // intentionally swallowed — see jsdoc
  }
}

/**
 * Run the idempotent server-side onboarding start-chat operation: create-or-reuse
 * the first chat, send the bootstrap message if the chat is empty, and
 * optionally stamp completion. Single-chat paths use the default stamp.
 *
 * NOT best-effort: a failure here means start-chat didn't happen, so the caller
 * surfaces it and lets the user retry.
 */
export async function postOnboardingStartChat(args: StartOnboardingChatArgs): Promise<StartOnboardingChatResult> {
  return api.post<StartOnboardingChatResult>("/me/onboarding/kickoff", args);
}

export type TreeSetupStartChatArgs = {
  organizationId: string;
  agentUuid: string;
};

export async function postTreeSetupStartChat(args: TreeSetupStartChatArgs): Promise<StartOnboardingChatResult> {
  const { organizationId, ...body } = args;
  return api.post<StartOnboardingChatResult>(
    `/orgs/${encodeURIComponent(organizationId)}/context-tree/setup-chat`,
    body,
  );
}

export type TreeSetupStatus = {
  needsTreeSetup: boolean;
  hasTreeBinding: boolean;
  hasTreeSetupStartChat: boolean;
};

export async function getTreeSetupStatus(organizationId: string): Promise<TreeSetupStatus> {
  const params = new URLSearchParams({ organizationId });
  const status = await api.get<TreeSetupStatus & { hasTreeSetupKickoff?: boolean }>(
    `/me/onboarding/tree-setup-status?${params.toString()}`,
  );
  return {
    needsTreeSetup: status.needsTreeSetup,
    hasTreeBinding: status.hasTreeBinding,
    hasTreeSetupStartChat: Boolean(status.hasTreeSetupStartChat ?? status.hasTreeSetupKickoff),
  };
}
