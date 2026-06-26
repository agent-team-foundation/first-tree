const INTENT_KEY = "first-tree:quickstart:intent";

export type CampaignKind = "production_scan";

export type CampaignIntent = {
  campaign: CampaignKind;
  owner: string;
  repo: string;
  repoSlug: string;
  url: string;
};

type RepoIntent = Omit<CampaignIntent, "campaign">;

const OWNER_RE = /^[A-Za-z0-9_.-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

function cleanRepoName(repo: string): string {
  return repo.replace(/\.git$/u, "");
}

function makeIntent(owner: string, repoInput: string): RepoIntent | null {
  const repo = cleanRepoName(repoInput);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  return {
    owner,
    repo,
    repoSlug: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

export function normalizeGitHubRepoUrl(input: string): RepoIntent | null {
  const raw = input.trim();
  if (!raw) return null;

  const ssh = raw.match(/^git@github\.com:([^/]+)\/(.+?)(?:\/)?$/u);
  if (ssh) {
    return makeIntent(ssh[1] ?? "", ssh[2] ?? "");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return null;
  const [owner, repo] = parsed.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  return makeIntent(owner, repo);
}

function normalizeCampaign(input: string | null): CampaignKind | null {
  const normalized = input?.trim().toLowerCase().replace(/-/gu, "_");
  return normalized === "production_scan" ? "production_scan" : null;
}

function campaignIntent(campaign: CampaignKind, repoUrl: string): CampaignIntent | null {
  const repo = normalizeGitHubRepoUrl(repoUrl);
  return repo ? { campaign, ...repo } : null;
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
    const value = JSON.parse(raw) as Partial<CampaignIntent>;
    if (
      normalizeCampaign(value.campaign ?? null) === null ||
      typeof value.owner !== "string" ||
      typeof value.repo !== "string" ||
      typeof value.repoSlug !== "string" ||
      typeof value.url !== "string"
    ) {
      throw new Error("invalid quickstart intent");
    }
    return { ...value, campaign: normalizeCampaign(value.campaign ?? null) } as CampaignIntent;
  } catch {
    clearCampaignIntent();
    return null;
  }
}

export function clearCampaignIntent(): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(INTENT_KEY);
}

export function deriveRepoAgentDisplayName(repo: string): string {
  const words = cleanRepoName(repo)
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return `${words.length > 0 ? words.join(" ") : "Repo"} scan agent`;
}

function paramsFromHash(hash: string): URLSearchParams {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return new URLSearchParams(raw.startsWith("?") ? raw.slice(1) : raw);
}

export function readCampaignHandoff(location: Pick<Location, "search" | "hash">): CampaignIntent | null {
  for (const params of [new URLSearchParams(location.search ?? ""), paramsFromHash(location.hash ?? "")]) {
    const campaign = normalizeCampaign(params.get("campaign") ?? params.get("intent"));
    if (!campaign) continue;
    const repo = params.get("repo");
    if (!repo) continue;
    const intent = campaignIntent(campaign, repo);
    if (intent) return intent;
  }
  return null;
}
