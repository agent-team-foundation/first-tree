import { isKnownLandingCampaignSlug, type KnownLandingCampaignSlug } from "@first-tree/shared";

/**
 * Onboarding-related browser-side flags (sessionStorage).
 *
 * - `joinPath`: set by the OAuth-complete page and the invite-accept handler;
 *   cleared by AuthContext once onboardingStep reaches `completed`. Its former
 *   reader — the retired inline onboarding greeting — is gone, so it's
 *   currently write-only: re-wire it into the new invitee welcome copy, or drop
 *   it along with its writers/clearer.
 * - `agentUuid`: the agent created mid-flow, so the kickoff step resolves the
 *   right agent on a re-visit.
 */

const JOIN_PATH_KEY = "onboarding:joinPath";

const ONBOARDING_AGENT_UUID_KEY = "onboarding:agentUuid";

const SELECTED_REPOS_KEY = (orgId: string) => `onboarding:selectedRepos:${orgId}`;

/**
 * Per-org draft of the repos the admin picked on the connect-code step.
 *
 * Persisted so leaving before kickoff — the top-bar "I'll finish later", a
 * refresh, or a mid-flow navigation — doesn't silently discard the selection;
 * the user resumes the wizard with the repos they chose still ticked. The
 * formal team-resource write still happens only at kickoff ("Build tree &
 * start"); this is purely an in-flight draft so the choice survives a bailout.
 *
 * Per-tab (sessionStorage), matching the other onboarding flags and the
 * same-session continuation the flow targets. Keyed by org so a multi-org user
 * keeps an independent draft per team.
 *
 * Returns `null` when no draft exists (the user hasn't touched the picker yet)
 * — distinct from `[]`, which means they deliberately deselected everything.
 * The connect-code step needs that distinction: it only auto-selects all
 * granted repos when there is NO draft, so a resumed narrowing (to a subset, or
 * to none) is never clobbered back to "all".
 */
export function readOnboardingSelectedRepos(orgId: string): string[] | null {
  if (typeof window === "undefined" || !orgId) return null;
  const raw = window.sessionStorage.getItem(SELECTED_REPOS_KEY(orgId));
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const urls: string[] = [];
    for (const u of parsed) {
      if (typeof u !== "string") return null;
      urls.push(u);
    }
    return urls;
  } catch {
    return null;
  }
}

export function writeOnboardingSelectedRepos(orgId: string, urls: string[] | null): void {
  if (typeof window === "undefined" || !orgId) return;
  if (urls === null) window.sessionStorage.removeItem(SELECTED_REPOS_KEY(orgId));
  else window.sessionStorage.setItem(SELECTED_REPOS_KEY(orgId), JSON.stringify(urls));
}

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

export type OnboardingJoinPath = "solo" | "invite";

/**
 * Mark the join path so a future surface can pick context-aware welcome copy.
 * Idempotent — overwriting is fine. (Currently write-only; see file header.)
 */
export function markOnboardingResume(joinPath: OnboardingJoinPath): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(JOIN_PATH_KEY, joinPath);
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

/**
 * Drop every `onboarding:*` sessionStorage key. Called on logout so a
 * subsequent login (e.g. after a dev DB reset) doesn't inherit a stale agent
 * UUID or join-path hint from the prior identity. Iterates the namespace so
 * future flags added with the same prefix are covered automatically.
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

const CAMPAIGN_ACTION_HANDOFF_KEY = "onboarding:campaignActionHandoff";
const LEGACY_SCAN_FIX_HANDOFF_KEY = "onboarding:scanFixHandoff";

/**
 * Campaign action captured by /quickstart (`action=<configured action>`).
 * Global like `agentUuid` (the fix link carries no org); consumed and cleared
 * by the onboarding start-chat completion, kept by `finishLater`. The durable
 * fallback is the fix link itself — the user can always re-click it.
 */
export type StoredCampaignActionHandoff = {
  campaign: KnownLandingCampaignSlug;
  repoUrl: string;
  reportKey: string | null;
  /**
   * `owner/repo` — used to key the onboarding-path fix launcher on the repo so
   * it dedups with the already-onboarded direct path. Optional so a flag stored
   * by a pre-deploy bundle still resolves (that user just misses cross-path
   * dedup until they re-click the fix link).
   */
  repoSlug?: string;
};

function parseStoredCampaignActionHandoff(raw: string, campaign?: unknown): StoredCampaignActionHandoff | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const o = parsed as Record<string, unknown>;
    const resolvedCampaign = campaign ?? o.campaign;
    if (
      !isKnownLandingCampaignSlug(resolvedCampaign) ||
      typeof o.repoUrl !== "string" ||
      !(typeof o.reportKey === "string" || o.reportKey === null)
    ) {
      throw new Error("invalid campaign action handoff");
    }
    const repoSlug =
      typeof o.repoSlug === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(o.repoSlug) ? o.repoSlug : undefined;
    return {
      campaign: resolvedCampaign,
      repoUrl: o.repoUrl,
      reportKey: o.reportKey,
      ...(repoSlug ? { repoSlug } : {}),
    };
  } catch {
    return null;
  }
}

export function readCampaignActionHandoffFlag(): StoredCampaignActionHandoff | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(CAMPAIGN_ACTION_HANDOFF_KEY);
  if (raw) {
    const parsed = parseStoredCampaignActionHandoff(raw);
    if (parsed) return parsed;
    window.sessionStorage.removeItem(CAMPAIGN_ACTION_HANDOFF_KEY);
  }

  // Normalize the one deployed pre-generic shape so an OAuth/onboarding tab
  // opened before this release still reaches the same production-scan action.
  const legacyRaw = window.sessionStorage.getItem(LEGACY_SCAN_FIX_HANDOFF_KEY);
  if (!legacyRaw) return null;
  const legacy = parseStoredCampaignActionHandoff(legacyRaw, "production-scan");
  if (legacy) return legacy;
  window.sessionStorage.removeItem(LEGACY_SCAN_FIX_HANDOFF_KEY);
  return null;
}

export function writeCampaignActionHandoffFlag(handoff: StoredCampaignActionHandoff | null): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(LEGACY_SCAN_FIX_HANDOFF_KEY);
  if (handoff === null) window.sessionStorage.removeItem(CAMPAIGN_ACTION_HANDOFF_KEY);
  else window.sessionStorage.setItem(CAMPAIGN_ACTION_HANDOFF_KEY, JSON.stringify(handoff));
}

/** Compatibility shape/functions for already-deployed production-scan callers. */
export type StoredScanFixHandoff = Omit<StoredCampaignActionHandoff, "campaign">;

export function readScanFixHandoffFlag(): StoredScanFixHandoff | null {
  const handoff = readCampaignActionHandoffFlag();
  if (handoff?.campaign !== "production-scan") return null;
  const { campaign: _campaign, ...legacy } = handoff;
  return legacy;
}

export function writeScanFixHandoffFlag(handoff: StoredScanFixHandoff | null): void {
  writeCampaignActionHandoffFlag(handoff ? { campaign: "production-scan", ...handoff } : null);
}
