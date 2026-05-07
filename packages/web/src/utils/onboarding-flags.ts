/**
 * Onboarding-related browser-side flags.
 *
 * - `joinPath` (sessionStorage): set by the OAuth-complete page and the
 *   invite-accept handler. Drives the OnboardingView greeting copy
 *   ("Welcome — you've joined {team}." vs "Welcome to First Tree Hub.").
 *   Cleared by AuthContext once the user's wizard reaches `completed`.
 * - `draft` (sessionStorage): keeps the inline onboarding form stable while
 *   the user navigates between app tabs before creating their first agent.
 * - `firstTreeBootstrap` (sessionStorage): set by OnboardingView right
 *   before navigating to the new chat. ChatView reads it once the chat is
 *   ready and auto-sends a one-time message asking the agent to install
 *   the First-Tree skill in the current repository. Stored as the chatId
 *   so a stale flag doesn't fire on an unrelated chat. Eagerly cleared
 *   the moment the bootstrap mutation kicks off so a slow tab-close
 *   doesn't double-send on reopen — failed sends require a manual retry.
 *   Lives in sessionStorage (not the URL) so the chat-first workspace
 *   refactor's `?c=` redirect can't strip it on the way in.
 */

const JOIN_PATH_KEY = "onboarding:joinPath";
const DRAFT_KEY_PREFIX = "onboarding:draft";
const FIRST_TREE_BOOTSTRAP_KEY = "onboarding:first-tree-bootstrap";

export type OnboardingJoinPath = "solo" | "invite";
export type OnboardingDraft = {
  displayName: string;
  selectedRuntime: string | null;
  connectToken: string | null;
  connectTokenExpiresAt: number | null;
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
 * Drop the join-path flag. Called once `wizard.step` reaches `completed` so
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
  return {
    displayName: value.displayName,
    selectedRuntime,
    connectToken,
    connectTokenExpiresAt,
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
 * Mark a chatId as needing the First-Tree bootstrap message on next mount.
 * Called by OnboardingView right before navigating into the chat. Idempotent
 * — overwriting a stale chatId is fine; only the most recently scheduled
 * chat is honored.
 */
export function markFirstTreeBootstrap(chatId: string): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(FIRST_TREE_BOOTSTRAP_KEY, chatId);
}

/** Read the pending bootstrap chatId, or null if none is scheduled. */
export function readFirstTreeBootstrap(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(FIRST_TREE_BOOTSTRAP_KEY);
}

/** Drop the bootstrap flag — call as soon as the message has been queued. */
export function clearFirstTreeBootstrap(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(FIRST_TREE_BOOTSTRAP_KEY);
}
