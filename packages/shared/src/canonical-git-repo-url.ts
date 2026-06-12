/**
 * Canonical identity form of a git repo URL: `host/owner/repo` — lowercase
 * host, no scheme, no credentials, no trailing `.git` / slashes. Two local
 * checkouts belong to the same repo iff their remotes canonicalize equal,
 * regardless of https vs scp-like ssh spelling.
 *
 * Single source of truth shared by the server (Context Tree IO ref
 * validation) and the client (repo-identity attribution of local paths).
 * Returns null for values that don't parse as a repo URL.
 */
export function canonicalGitRepoUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const scpLike = /^(?:[^@/\s]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes("://")) {
    const host = scpLike[1];
    const rawPath = scpLike[2];
    if (!host || !rawPath) return null;
    const path = normalizeGitRepoPath(rawPath);
    return path ? `${host.toLowerCase()}/${path}` : null;
  }

  try {
    const url = new URL(trimmed);
    const path = normalizeGitRepoPath(url.pathname);
    return path ? `${url.hostname.toLowerCase()}/${path}` : null;
  } catch {
    return null;
  }
}

function normalizeGitRepoPath(rawPath: string): string | null {
  let path = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return path.length > 0 ? path : null;
}
