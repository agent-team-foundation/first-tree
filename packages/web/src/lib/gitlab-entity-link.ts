import { parseGitlabEntityPath } from "@first-tree/shared";

export type GitlabEntityLinkPresentation = {
  label: string;
  title: string;
};

/**
 * Build the compact label for a bare GitLab entity URL from the Team's
 * connected instance. The href itself is never rewritten.
 */
export function gitlabEntityLinkPresentation(
  href: string | undefined,
  connectedInstanceOrigin: string | null,
): GitlabEntityLinkPresentation | null {
  if (!href || !connectedInstanceOrigin) return null;

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== connectedInstanceOrigin || url.username || url.password || url.search || url.hash) return null;

  const parsed = parseGitlabEntityPath(url.pathname);
  if (!parsed.ok) return null;

  const sigil = parsed.value.entityType === "pull_request" ? "!" : "#";
  return {
    label: `${parsed.value.projectPath}${sigil}${parsed.value.entityIid}`,
    title: href,
  };
}
