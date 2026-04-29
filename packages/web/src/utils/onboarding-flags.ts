/**
 * Shared sessionStorage flags consumed by `OnboardingProvider` to decide
 * whether the wizard modal should auto-open after a token-adoption surface
 * (OAuth fragment consumer, invite-accept). Centralising the keys here
 * avoids drift between the two writers and the single reader.
 */

const AUTO_OPEN_KEY = "onboarding:autoOpen";
const JOIN_PATH_KEY = "onboarding:joinPath";

export type OnboardingJoinPath = "solo" | "invite";

/**
 * Mark "the next time the dashboard mounts, auto-open the onboarding modal
 * (with copy keyed off `joinPath`)." Idempotent — overwriting is fine.
 */
export function markOnboardingResume(joinPath: OnboardingJoinPath): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(AUTO_OPEN_KEY, "1");
  window.sessionStorage.setItem(JOIN_PATH_KEY, joinPath);
}

/** Internal — used by `OnboardingProvider` to consume + clear the flag. */
export const ONBOARDING_AUTO_OPEN_KEY = AUTO_OPEN_KEY;
export const ONBOARDING_JOIN_PATH_KEY = JOIN_PATH_KEY;
