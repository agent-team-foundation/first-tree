export const CONTEXT_TREE_PROVIDERS = ["github", "gitlab"] as const;
export type ContextTreeProvider = (typeof CONTEXT_TREE_PROVIDERS)[number];

export type CanonicalGitRepoIdentity = {
  canonical: string;
  host: string;
  path: string;
};

export type ContextTreeProviderResolution = {
  identity: CanonicalGitRepoIdentity | null;
  provider: ContextTreeProvider | null;
  source: "declared" | "github_host" | "gitlab_connection" | "unknown";
  declaredProviderMatches: boolean;
  gitlabConnectionMatches: boolean;
};

export type GitLabRepositoryWebIdentity = {
  origin: string;
  path: string;
  cloneUrl: string;
  originMatchesConnection: boolean;
};

export type ContextTreeRepositoryMatchInput = {
  left: string | null | undefined;
  right: string | null | undefined;
  provider: ContextTreeProvider;
  gitlabInstanceOrigin?: string | null;
};

/**
 * Canonical identity form of a git repo URL: `host/namespace/repo` — lowercase,
 * no scheme, no credentials, and no trailing `.git` / slashes. GitHub and
 * GitLab repository paths are case-insensitive identities, including GitLab's
 * nested group/subgroup namespaces.
 *
 * This is the provider-neutral source of truth shared by Server, CLI, Web, and
 * agent workflows. It deliberately separates repository identity from the
 * transport used by a local checkout.
 */
export function canonicalGitRepoIdentity(value: string | null | undefined): CanonicalGitRepoIdentity | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const scpLike = /^(?:[^@/\s]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes("://")) {
    const host = scpLike[1];
    const rawPath = scpLike[2];
    if (!host || !rawPath) return null;
    const path = normalizeGitRepoPath(rawPath);
    if (!path) return null;
    const normalizedHost = host.toLowerCase();
    return { canonical: `${normalizedHost}/${path}`, host: normalizedHost, path };
  }

  try {
    const url = new URL(trimmed);
    const path = normalizeGitRepoPath(url.pathname);
    if (!path || !url.hostname) return null;
    const host = url.hostname.toLowerCase();
    return { canonical: `${host}/${path}`, host, path };
  } catch {
    return null;
  }
}

/** Backward-compatible canonical repository key. */
export function canonicalGitRepoUrl(value: string | null | undefined): string | null {
  return canonicalGitRepoIdentity(value)?.canonical ?? null;
}

/**
 * Compare two Context Tree repository references at forge authority strength.
 *
 * The provider-neutral canonical key intentionally ignores transport details,
 * but executable provider checks cannot: GitHub has one fixed web origin and
 * GitLab HTTPS identities include the exact web port. SSH transports map
 * through the current GitLab connection instead of treating their SSH port as
 * a web port.
 */
export function sameContextTreeRepository(input: ContextTreeRepositoryMatchInput): boolean {
  const left = canonicalGitRepoIdentity(input.left);
  const right = canonicalGitRepoIdentity(input.right);
  if (!left || !right || left.canonical !== right.canonical) return false;

  if (input.provider === "github") {
    return isGithubRepositoryTransport(input.left) && isGithubRepositoryTransport(input.right);
  }

  if (input.gitlabInstanceOrigin) {
    const leftWeb = resolveGitLabRepositoryWebIdentity(input.left, input.gitlabInstanceOrigin);
    const rightWeb = resolveGitLabRepositoryWebIdentity(input.right, input.gitlabInstanceOrigin);
    return leftWeb?.originMatchesConnection === true && rightWeb?.originMatchesConnection === true;
  }

  const leftOrigin = httpsRepositoryOrigin(input.left);
  const rightOrigin = httpsRepositoryOrigin(input.right);
  if (leftOrigin !== null || rightOrigin !== null) {
    return leftOrigin !== null && rightOrigin !== null && leftOrigin === rightOrigin;
  }
  return true;
}

/**
 * Resolve the executable Context Tree provider without guessing unknown
 * self-managed hosts. A persisted provider remains authoritative for legacy
 * connection-loss/degraded states; otherwise only github.com or the current
 * Team GitLab connection can classify a repository.
 */
export function resolveContextTreeProvider(input: {
  repo: string | null | undefined;
  declaredProvider?: ContextTreeProvider | null;
  gitlabInstanceOrigin?: string | null;
}): ContextTreeProviderResolution {
  const identity = canonicalGitRepoIdentity(input.repo);
  const gitlabConnectionMatches =
    resolveGitLabRepositoryWebIdentity(input.repo, input.gitlabInstanceOrigin)?.originMatchesConnection === true;
  const declaredProviderMatches =
    input.declaredProvider === undefined ||
    input.declaredProvider === null ||
    (input.declaredProvider === "github"
      ? isGithubRepositoryTransport(input.repo)
      : identity !== null && identity.host !== "github.com");

  if (input.declaredProvider) {
    return {
      identity,
      provider: input.declaredProvider,
      source: "declared",
      declaredProviderMatches,
      gitlabConnectionMatches,
    };
  }
  if (isGithubRepositoryTransport(input.repo)) {
    return {
      identity,
      provider: "github",
      source: "github_host",
      declaredProviderMatches,
      gitlabConnectionMatches,
    };
  }
  if (gitlabConnectionMatches) {
    return {
      identity,
      provider: "gitlab",
      source: "gitlab_connection",
      declaredProviderMatches,
      gitlabConnectionMatches: true,
    };
  }
  return { identity, provider: null, source: "unknown", declaredProviderMatches, gitlabConnectionMatches };
}

/**
 * Resolve a GitLab repository transport against the Team's forge web origin.
 * HTTPS repositories must match the complete normalized origin, including a
 * non-default port. SSH/scp transports contribute only hostname + project
 * path; their transport port is never treated as the GitLab web port.
 */
export function resolveGitLabRepositoryWebIdentity(
  repo: string | null | undefined,
  instanceOrigin: string | null | undefined,
): GitLabRepositoryWebIdentity | null {
  const origin = normalizeGitLabWebOrigin(instanceOrigin);
  const identity = canonicalGitRepoIdentity(repo);
  if (!origin || !identity || identity.host === "github.com") return null;
  const originUrl = new URL(origin);
  const value = repo?.trim() ?? "";
  let transportOrigin: string | null = null;
  if (value.includes("://")) {
    try {
      const transportUrl = new URL(value);
      if (transportUrl.protocol === "https:" || transportUrl.protocol === "http:") {
        transportOrigin = transportUrl.origin.toLowerCase();
      } else if (transportUrl.protocol !== "ssh:") {
        return null;
      }
    } catch {
      return null;
    }
  }
  const originMatchesConnection =
    transportOrigin !== null ? transportOrigin === origin : identity.host === originUrl.hostname.toLowerCase();
  return {
    origin,
    path: identity.path,
    cloneUrl: `${origin}/${identity.path}.git`,
    originMatchesConnection,
  };
}

export function normalizeGitLabWebOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function httpsRepositoryOrigin(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed?.includes("://")) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

function isGithubRepositoryTransport(value: string | null | undefined): boolean {
  const identity = canonicalGitRepoIdentity(value);
  if (identity?.host !== "github.com") return false;
  const trimmed = value?.trim() ?? "";
  if (!trimmed.includes("://")) return true;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "ssh:") return url.hostname.toLowerCase() === "github.com";
    return url.protocol === "https:" && url.origin.toLowerCase() === "https://github.com";
  } catch {
    return false;
  }
}

function normalizeGitRepoPath(rawPath: string): string | null {
  // Trim slashes without regex: CodeQL flags `/\/+$/`-style patterns as
  // polynomial on adversarial many-slash inputs (js/polynomial-redos).
  let start = 0;
  let end = rawPath.length;
  while (start < end && rawPath[start] === "/") start++;
  while (end > start && rawPath[end - 1] === "/") end--;
  let path = rawPath.slice(start, end);
  if (path.toLowerCase().endsWith(".git")) path = path.slice(0, -4);
  return path.length > 0 ? path.toLowerCase() : null;
}
