const NUMERIC_ENTITY_KEY = /^([^/\s]+)\/([^/\s#@]+)#(\d+)$/;
const LEGACY_DISCUSSION_ENTITY_KEY = /^([^/\s]+)\/([^/\s#@]+)#discussion-(\d+)$/;

export function canonicalizeGithubEntityKey(entityType: string, entityKey: string): string {
  if (entityType !== "discussion") return entityKey;
  const legacy = LEGACY_DISCUSSION_ENTITY_KEY.exec(entityKey);
  if (!legacy) return entityKey;
  // Capture groups are always present when the regex matches.
  const owner = legacy[1] as string;
  const repo = legacy[2] as string;
  const number = legacy[3] as string;
  return `${owner}/${repo}#${number}`;
}

export function legacyDiscussionEntityKey(entityKey: string): string | null {
  const numeric = NUMERIC_ENTITY_KEY.exec(entityKey);
  if (!numeric) return null;
  // Capture groups are always present when the regex matches.
  const owner = numeric[1] as string;
  const repo = numeric[2] as string;
  const number = numeric[3] as string;
  return `${owner}/${repo}#discussion-${number}`;
}

export function githubEntityKeyCandidates(entityType: string, entityKey: string): string[] {
  if (entityType !== "discussion") return [entityKey];

  const canonical = canonicalizeGithubEntityKey(entityType, entityKey);
  const legacy = legacyDiscussionEntityKey(canonical);
  return [...new Set([entityKey, canonical, legacy].filter((value): value is string => value !== null))];
}

export function githubEntityDedupKey(entityType: string, entityKey: string): string {
  return `${entityType}::${canonicalizeGithubEntityKey(entityType, entityKey)}`;
}

export function githubEntityKeysEquivalent(entityType: string, left: string, right: string): boolean {
  return canonicalizeGithubEntityKey(entityType, left) === canonicalizeGithubEntityKey(entityType, right);
}
