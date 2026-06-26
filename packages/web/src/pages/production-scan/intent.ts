const INTENT_KEY = "first-tree:production-scan:intent";

export type ProductionScanIntent = {
  owner: string;
  repo: string;
  repoSlug: string;
  url: string;
};

const OWNER_RE = /^[A-Za-z0-9_.-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+$/;

function cleanRepoName(repo: string): string {
  return repo.replace(/\.git$/u, "");
}

function makeIntent(owner: string, repoInput: string): ProductionScanIntent | null {
  const repo = cleanRepoName(repoInput);
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return null;
  return {
    owner,
    repo,
    repoSlug: `${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

export function normalizeGitHubRepoUrl(input: string): ProductionScanIntent | null {
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

export function writeProductionScanIntent(intent: ProductionScanIntent): void {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(INTENT_KEY, JSON.stringify(intent));
}

export function readProductionScanIntent(): ProductionScanIntent | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(INTENT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ProductionScanIntent>;
    if (
      typeof value.owner !== "string" ||
      typeof value.repo !== "string" ||
      typeof value.repoSlug !== "string" ||
      typeof value.url !== "string"
    ) {
      throw new Error("invalid production scan intent");
    }
    return value as ProductionScanIntent;
  } catch {
    clearProductionScanIntent();
    return null;
  }
}

export function clearProductionScanIntent(): void {
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

export function readProductionScanHandoff(location: Pick<Location, "search" | "hash">): ProductionScanIntent | null {
  for (const params of [new URLSearchParams(location.search ?? ""), paramsFromHash(location.hash ?? "")]) {
    if (params.get("intent") !== "production-scan") continue;
    const repo = params.get("repo");
    if (!repo) continue;
    const intent = normalizeGitHubRepoUrl(repo);
    if (intent) return intent;
  }
  return null;
}
