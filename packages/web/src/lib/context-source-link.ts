import { canonicalGitRepoIdentity, resolveGitLabRepositoryWebIdentity } from "@first-tree/shared";

/**
 * Exact-commit file link for a cited Context Tree node, or `null` when the
 * forge cannot be identified with confidence.
 *
 * GitHub is recognized by host; a non-GitHub host only links when it matches
 * the Team's connected GitLab origin. Everything else stays plain text — a
 * broken link would undermine the one thing a citation can promise: the cited
 * source is inspectable, at the exact version it was read at.
 */
export function contextTreeSourceHref(
  source: { repoUrl: string; commit: string; nodePath: string },
  gitlabInstanceOrigin: string | null,
): string | null {
  const identity = canonicalGitRepoIdentity(source.repoUrl);
  if (!identity) return null;
  const path = source.nodePath.split("/").map(encodeURIComponent).join("/");
  if (identity.host === "github.com") {
    return `https://github.com/${identity.path}/blob/${source.commit}/${path}`;
  }
  const gitlab = resolveGitLabRepositoryWebIdentity(source.repoUrl, gitlabInstanceOrigin);
  if (gitlab?.originMatchesConnection) {
    return `${gitlab.origin}/${gitlab.path}/-/blob/${source.commit}/${path}`;
  }
  return null;
}
