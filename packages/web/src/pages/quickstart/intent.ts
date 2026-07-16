import { type CampaignSlug, getCampaign, isKnownCampaign } from "./campaigns.js";

/**
 * Parsing for the landing-page → quickstart handoff. The landing CTA points the
 * browser at `/quickstart?campaign=<slug>&repo=<github url>` (the legacy
 * `intent=` alias is also accepted); after the login round-trip the params may
 * arrive in the hash instead. We keep the parsed intent in sessionStorage so it
 * survives the OAuth bounce, and only ever store/return a KNOWN campaign + a
 * normalized GitHub repo.
 */

const INTENT_KEY = "first-tree:quickstart:intent";

/** A normalized GitHub repo reference parsed from a landing handoff. */
export type RepoIntent = {
  owner: string;
  repo: string;
  repoSlug: string;
  url: string;
};

/** A campaign handoff: a known campaign slug + the repo it targets. */
export type CampaignIntent = RepoIntent & { campaign: CampaignSlug };

/** A campaign result CTA landing back on Cloud for work by the user's agent. */
export type CampaignActionHandoff = CampaignIntent & {
  action: string;
  /** Hosted-report key stem (no extension), or null when the link carried none or an invalid one. */
  reportKey: string | null;
};

/** Compatibility shape for the deployed production-scan action. */
export type ScanFixHandoff = CampaignIntent & { campaign: "production-scan"; reportKey: string | null };

const NAME_RE = /^[A-Za-z0-9_.-]+$/u;

// S3 object basename stem: `<owner>-<repo>-<YYYYMMDD>-<hash>`; owner/repo may
// contain dots. Whitelist, never blacklist — the key is embedded into
// report.first-tree.ai URLs in bootstrap prose.
const REPORT_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

function cleanRepoName(repo: string): string {
  return repo.replace(/\.git$/u, "");
}

function makeRepoIntent(owner: string, repoInput: string): RepoIntent | null {
  const repo = cleanRepoName(repoInput);
  if (!NAME_RE.test(owner) || !NAME_RE.test(repo)) return null;
  return { owner, repo, repoSlug: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}` };
}

export function normalizeGitHubRepoUrl(input: string): RepoIntent | null {
  const raw = input.trim();
  if (!raw) return null;

  const ssh = raw.match(/^git@github\.com:([^/]+)\/(.+?)\/?$/u);
  if (ssh) return makeRepoIntent(ssh[1] ?? "", ssh[2] ?? "");

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  return makeRepoIntent(owner, repo);
}

function normalizeCampaign(input: string | null): CampaignSlug | null {
  const slug = input?.trim().toLowerCase() ?? null;
  return isKnownCampaign(slug) ? slug : null;
}

export function normalizeReportKey(raw: string | null): string | null {
  if (!raw) return null;
  const stem = raw.trim().replace(/\.(html|json)$/u, "");
  return REPORT_KEY_RE.test(stem) ? stem : null;
}

function paramsFromHash(hash: string): URLSearchParams {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
}

function normalizeAction(params: URLSearchParams): string | null {
  const action = (params.get("action") ?? "").trim().toLowerCase();
  return action || null;
}

/** Read a configured campaign action handoff (query first, then hash). */
export function readCampaignActionHandoff(location: Pick<Location, "search" | "hash">): CampaignActionHandoff | null {
  for (const params of [new URLSearchParams(location.search ?? ""), paramsFromHash(location.hash ?? "")]) {
    const campaign = normalizeCampaign(params.get("campaign") ?? params.get("intent"));
    if (!campaign) continue;
    const config = getCampaign(campaign);
    const action = normalizeAction(params);
    if (!config || action !== config.action.queryValue) continue;
    const repoRaw = params.get("repo");
    if (!repoRaw) continue;
    const repo = normalizeGitHubRepoUrl(repoRaw);
    if (repo) return { campaign, action, ...repo, reportKey: normalizeReportKey(params.get("report")) };
  }
  return null;
}

/** Read the deployed production-scan fix action (compatibility wrapper). */
export function readScanFixHandoff(location: Pick<Location, "search" | "hash">): ScanFixHandoff | null {
  const handoff = readCampaignActionHandoff(location);
  if (handoff?.campaign !== "production-scan" || handoff.action !== "fix") return null;
  const { action: _action, ...scanFix } = handoff;
  return { ...scanFix, campaign: "production-scan" };
}

/** Read a campaign handoff off the current location (query first, then hash). */
export function readCampaignHandoff(location: Pick<Location, "search" | "hash">): CampaignIntent | null {
  for (const params of [new URLSearchParams(location.search ?? ""), paramsFromHash(location.hash ?? "")]) {
    // Any explicit action is never a trial launch, even if it is unknown.
    if (normalizeAction(params)) continue;
    const campaign = normalizeCampaign(params.get("campaign") ?? params.get("intent"));
    if (!campaign) continue;
    const repoRaw = params.get("repo");
    if (!repoRaw) continue;
    const repo = normalizeGitHubRepoUrl(repoRaw);
    if (repo) return { campaign, ...repo };
  }
  return null;
}

/** Whether the current location explicitly attempted a campaign handoff. */
export function hasCampaignHandoff(location: Pick<Location, "search" | "hash">): boolean {
  return [new URLSearchParams(location.search ?? ""), paramsFromHash(location.hash ?? "")].some(
    (params) => params.has("campaign") || params.has("intent"),
  );
}

export function writeCampaignIntent(intent: CampaignIntent): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
}

export function readCampaignIntent(): CampaignIntent | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(INTENT_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    // Validate field-by-field: we persist this ourselves, but a stale or
    // old-shape value (or a campaign that has since been retired) must be
    // rejected and cleared rather than trusted.
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    const o = parsed as Record<string, unknown>;
    if (
      !isKnownCampaign(o.campaign) ||
      typeof o.owner !== "string" ||
      typeof o.repo !== "string" ||
      typeof o.repoSlug !== "string" ||
      typeof o.url !== "string"
    ) {
      throw new Error("invalid quickstart intent");
    }
    return { campaign: o.campaign, owner: o.owner, repo: o.repo, repoSlug: o.repoSlug, url: o.url };
  } catch {
    clearCampaignIntent();
    return null;
  }
}

export function clearCampaignIntent(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(INTENT_KEY);
}
