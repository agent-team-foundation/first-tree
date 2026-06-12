const NUMERIC_ENTITY_KEY = /^([^/\s]+)\/([^/\s#@]+)#(\d+)$/;
const LEGACY_DISCUSSION_ENTITY_KEY = /^([^/\s]+)\/([^/\s#@]+)#discussion-(\d+)$/;

export function canonicalizeGithubEntityKey(entityType: string, entityKey: string): string {
  if (entityType !== "discussion") return entityKey;
  const legacy = LEGACY_DISCUSSION_ENTITY_KEY.exec(entityKey);
  if (!legacy) return entityKey;
  const [, owner, repo, number] = legacy;
  if (!owner || !repo || !number) return entityKey;
  return `${owner}/${repo}#${number}`;
}

export function legacyDiscussionEntityKey(entityKey: string): string | null {
  const numeric = NUMERIC_ENTITY_KEY.exec(entityKey);
  if (!numeric) return null;
  const [, owner, repo, number] = numeric;
  if (!owner || !repo || !number) return null;
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
