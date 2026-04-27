/**
 * Derive a URL-safe workspace slug from a free-text display name. Mirrors
 * the constraints baked into `createWorkspaceRequestSchema` server-side:
 * lowercase alphanumeric + hyphens, must start with alphanumeric, max 50
 * chars. The output isn't guaranteed to satisfy the regex (e.g. an
 * all-emoji input collapses to "") — UI uses it as an auto-suggest, not
 * as a final validation gate; the server has the last word.
 */
export function slugifyWorkspace(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}
