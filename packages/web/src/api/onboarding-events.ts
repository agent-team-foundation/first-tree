import type {
  KickoffOnboarding,
  KickoffOnboardingResult,
  OnboardingEvent,
  OnboardingEventName,
} from "@first-tree/shared";
import { api } from "./client.js";

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
 * Run the idempotent server-side onboarding kickoff: create-or-reuse the first
 * chat, send the bootstrap message if the chat is empty, and optionally stamp
 * completion. Single-chat paths use the default stamp; multi-chat paths defer it
 * until every required kickoff side effect has succeeded.
 *
 * NOT best-effort: a failure here means the kickoff didn't happen, so the caller
 * surfaces it and lets the user retry (the endpoint is safe to re-run).
 */
export async function kickoffOnboarding(args: KickoffOnboarding): Promise<KickoffOnboardingResult> {
  return api.post<KickoffOnboardingResult>("/me/onboarding/kickoff", args);
}
