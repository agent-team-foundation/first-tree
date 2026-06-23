/**
 * Normalize a user-pasted repository URL into a form `repoUrlSchema` accepts, so
 * the common GitHub paste shapes work without typing a scheme:
 *   - "https://github.com/org/repo(.git)" / "ssh://…" / "git@host:org/repo.git"
 *       → returned unchanged (already valid forms)
 *   - "github.com/org/repo"  → "https://github.com/org/repo"  (scheme-less host path)
 *   - "org/repo"             → "https://github.com/org/repo"  (GitHub shorthand)
 *
 * Anything we don't recognise is returned trimmed and left for schema validation
 * to reject with its own message — this only widens accepted input, it never
 * loosens the validation that runs on the result.
 */
export function normalizeRepoUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return value;
  // Already has an explicit scheme (https://, ssh://, git://, …).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value;
  // scp-like SSH: user@host:path (e.g. git@github.com:org/repo.git).
  if (/^[^@/\s]+@[^/\s:]+:[^/\s]/.test(value)) return value;
  // Scheme-less host path: "host.tld/owner/repo…" — prepend https://.
  if (/^[^/\s]+\.[^/\s]+\/\S+/.test(value)) return `https://${value}`;
  // GitHub shorthand: "owner/repo" (exactly one segment pair, no host).
  if (/^[^/\s]+\/[^/\s]+$/.test(value)) return `https://github.com/${value}`;
  return value;
}
