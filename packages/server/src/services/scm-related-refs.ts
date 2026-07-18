const CLOSING_REFERENCE_RE = /\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#(\d+)\b/giu;

/** Parse only the GitHub/GitLab common, same-project closing-reference subset. */
export function parseSameProjectClosingIssueRefs(
  text: string | null | undefined,
  projectKey: string,
  formatKey: (projectKey: string, issueNumber: string) => string = (project, issueNumber) =>
    `${project}#${issueNumber}`,
): Array<{ type: "issue"; key: string }> {
  if (!text) return [];
  const prose = text.replace(/```[\s\S]*?```/gu, " ").replace(/`[^`\n]*`/gu, " ");
  const refs: Array<{ type: "issue"; key: string }> = [];
  const seen = new Set<string>();
  for (const match of prose.matchAll(CLOSING_REFERENCE_RE)) {
    const number = match[1];
    if (!number) continue;
    const key = formatKey(projectKey, number);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ type: "issue", key });
  }
  return refs;
}
