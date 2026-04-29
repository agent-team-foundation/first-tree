/**
 * Onboarding-related browser-side flags.
 *
 * - `joinPath` (sessionStorage): set by the OAuth-complete page and the
 *   invite-accept handler. Drives the modal's greeting copy ("You've joined
 *   {team}." vs "Welcome — let's get you set up."). Cleared once the user's
 *   wizard reaches `completed`.
 *
 * - `bannerDismissed` (localStorage): set when the user clicks ✕ on the
 *   onboarding banner. localStorage (not sessionStorage) so dismiss persists
 *   across reloads but resets if the user signs in on a different device.
 *   Cleared when the user actually completes onboarding so the dismiss flag
 *   doesn't leak into a future "incomplete" state (e.g. they delete their
 *   client).
 */

const JOIN_PATH_KEY = "onboarding:joinPath";
const BANNER_DISMISSED_KEY = "onboarding:bannerDismissed";

export type OnboardingJoinPath = "solo" | "invite";

/**
 * Mark the join path so the next dashboard mount can pick context-aware
 * copy. Idempotent — overwriting is fine.
 */
export function markOnboardingResume(joinPath: OnboardingJoinPath): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(JOIN_PATH_KEY, joinPath);
}

/** Internal — used by `OnboardingProvider` to read/clear the flags. */
export const ONBOARDING_JOIN_PATH_KEY = JOIN_PATH_KEY;
export const ONBOARDING_BANNER_DISMISSED_KEY = BANNER_DISMISSED_KEY;
