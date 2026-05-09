import type { OnboardingEvent, OnboardingEventName } from "@agent-team-foundation/first-tree-hub-shared";
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
