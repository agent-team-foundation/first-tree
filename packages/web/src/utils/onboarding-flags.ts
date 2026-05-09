/**
 * Onboarding-related browser-side flags.
 *
 * - `joinPath` (sessionStorage): set by the OAuth-complete page and the
 *   invite-accept handler. Drives the OnboardingView greeting copy
 *   ("Welcome — you've joined {team}." vs "Welcome to First Tree Hub.").
 *   Cleared by AuthContext once the user's onboardingStep reaches `completed`.
 * - `draft` (sessionStorage): keeps the inline onboarding form stable while
 *   the user navigates between app tabs before creating their first agent.
 */

const JOIN_PATH_KEY = "onboarding:joinPath";
const DRAFT_KEY_PREFIX = "onboarding:draft";
const STEP1_CONFIRMED_KEY = "onboarding:step1Confirmed";

/**
 * Per-tab Step 1 acknowledgement. Server can't distinguish "team
 * auto-created at OAuth, user hasn't confirmed yet" from "team
 * confirmed days ago" — onboardingStep is `"connect"` in both. The
 * `OnboardingView` body resolver and the `OnboardingStepper`
 * active-step inference both read this so the stepper visuals match
 * the body that's rendering.
 */
export function readStep1Confirmed(): boolean {
  if (typeof window === "undefined") return false;
  return window.sessionStorage.getItem(STEP1_CONFIRMED_KEY) === "1";
}
export function writeStep1Confirmed(value: boolean): void {
  if (typeof window === "undefined") return;
  if (value) window.sessionStorage.setItem(STEP1_CONFIRMED_KEY, "1");
  else window.sessionStorage.removeItem(STEP1_CONFIRMED_KEY);
}

const ONBOARDING_AGENT_UUID_KEY = "onboarding:agentUuid";

/**
 * UUID of the agent created in Step 2. Step 3's [Yes, set it up] handler
 * uses this to start the chat against the right agent on a re-visit
 * (where `listManagedAgents` order is unspecified). Per-tab — fine for
 * the same-session continuation case the design targets.
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

const RETURN_CHAT_ID_KEY = "onboarding:returnChatId";

/**
 * Stash a chat id when the user clicks back to Step 1 / Step 2 from the
 * stepper while a chat is open in CenterPanel. Step 1's Continue handler
 * pops it back into the URL on advance so the user lands back in their
 * tree-init chat instead of `/`.
 */
export function readOnboardingReturnChatId(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(RETURN_CHAT_ID_KEY);
}
export function writeOnboardingReturnChatId(chatId: string | null): void {
  if (typeof window === "undefined") return;
  if (chatId) window.sessionStorage.setItem(RETURN_CHAT_ID_KEY, chatId);
  else window.sessionStorage.removeItem(RETURN_CHAT_ID_KEY);
}

export type OnboardingJoinPath = "solo" | "invite";
export type OnboardingDraft = {
  displayName: string;
  selectedRuntime: string | null;
  connectToken: string | null;
  connectTokenExpiresAt: number | null;
  /** Clone URL of the GitHub repo picked by the Step 2 picker. */
  selectedRepoUrl: string | null;
};

/**
 * Mark the join path so the next dashboard mount can pick context-aware
 * copy. Idempotent — overwriting is fine.
 */
export function markOnboardingResume(joinPath: OnboardingJoinPath): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(JOIN_PATH_KEY, joinPath);
}

/** Read the previously marked join path, or null if absent / invalid. */
export function readOnboardingJoinPath(): OnboardingJoinPath | null {
  if (typeof window === "undefined") return null;
  const v = window.sessionStorage.getItem(JOIN_PATH_KEY);
  return v === "solo" || v === "invite" ? v : null;
}

/**
 * Drop the join-path flag. Called once `onboarding.step` reaches `completed` so
 * a future incomplete state (e.g. user deletes their client) doesn't reuse a
 * stale "you've joined {team}" headline that no longer fits.
 */
export function clearOnboardingJoinPath(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(JOIN_PATH_KEY);
}

export function onboardingDraftScope(organizationId: string | null, memberId: string | null): string {
  return `${organizationId ?? "unknown-org"}:${memberId ?? "unknown-member"}`;
}

function onboardingDraftKey(scope: string): string {
  return `${DRAFT_KEY_PREFIX}:${scope}`;
}

function parseOnboardingDraft(value: unknown): OnboardingDraft | null {
  if (!value || typeof value !== "object") return null;
  if (!("displayName" in value) || typeof value.displayName !== "string") return null;
  const selectedRuntime = "selectedRuntime" in value ? value.selectedRuntime : null;
  if (selectedRuntime !== null && typeof selectedRuntime !== "string") return null;
  const connectToken = "connectToken" in value ? value.connectToken : null;
  if (connectToken !== null && typeof connectToken !== "string") return null;
  const connectTokenExpiresAt = "connectTokenExpiresAt" in value ? value.connectTokenExpiresAt : null;
  if (connectTokenExpiresAt !== null && typeof connectTokenExpiresAt !== "number") return null;
  const selectedRepoUrl = "selectedRepoUrl" in value ? value.selectedRepoUrl : null;
  if (selectedRepoUrl !== null && typeof selectedRepoUrl !== "string") return null;
  return {
    displayName: value.displayName,
    selectedRuntime,
    connectToken,
    connectTokenExpiresAt,
    selectedRepoUrl,
  };
}

export function readOnboardingDraft(scope: string): OnboardingDraft | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(onboardingDraftKey(scope));
  if (!raw) return null;
  try {
    return parseOnboardingDraft(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writeOnboardingDraft(scope: string, draft: OnboardingDraft): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(onboardingDraftKey(scope), JSON.stringify(draft));
}

export function clearOnboardingDraft(scope: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(onboardingDraftKey(scope));
}

/**
 * Drop every `onboarding:*` sessionStorage key. Called on logout so a
 * subsequent login (e.g. after a dev DB reset) doesn't inherit stale
 * Step 1/3 confirmations, agent UUID, return-chat hint, or scoped drafts
 * from the prior identity. Iterates the namespace so future flags added
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
