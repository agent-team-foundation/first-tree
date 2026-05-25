/**
 * Onboarding-related browser-side flags (sessionStorage).
 *
 * - `agentUuid`: the agent created mid-flow, so the kickoff step resolves the
 *   right agent on a re-visit.
 */

const ONBOARDING_AGENT_UUID_KEY = "onboarding:agentUuid";

/**
 * UUID of the agent created during onboarding. The kickoff step uses it to
 * start the first chat against the right agent on a re-visit (where
 * `listManagedAgents` order is unspecified). Per-tab — fine for the
 * same-session continuation case the design targets.
 */
export function readOnboardingAgentUuid(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(ONBOARDING_AGENT_UUID_KEY);
}
export function writeOnboardingAgentUuid(uuid: string | null): void {
  if (typeof window === "undefined") return;
  if (uuid) window.sessionStorage.setItem(ONBOARDING_AGENT_UUID_KEY, uuid);
  else window.sessionStorage.removeItem(ONBOARDING_AGENT_UUID_KEY);
}

/**
 * Drop every `onboarding:*` sessionStorage key. Called on logout so a
 * subsequent login (e.g. after a dev DB reset) doesn't inherit a stale agent
 * UUID from the prior identity. Iterates the namespace so future flags added
 * with the same prefix are covered automatically.
 */
export function clearOnboardingSessionFlags(): void {
  if (typeof window === "undefined") return;
  const ss = window.sessionStorage;
  const toRemove: string[] = [];
  for (let i = 0; i < ss.length; i++) {
    const k = ss.key(i);
    if (k?.startsWith("onboarding:")) toRemove.push(k);
  }
  for (const k of toRemove) ss.removeItem(k);
}
