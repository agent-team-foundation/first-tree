import { AGENT_NAME_MAX_LENGTH } from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Lowercase, ASCII-only slug from arbitrary unicode display names. Strips
 * leading/trailing separators and clamps to the agent-name length cap.
 * NFKD-normalized first so latin-1 accents collapse to their base letter
 * (`café` → `cafe`) instead of being lost. Returns an empty string for input
 * that has no representable ASCII (e.g. all CJK or emoji) — callers should
 * treat empty as "let the server leave name NULL" rather than as a valid slug.
 */
export function slugify(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, AGENT_NAME_MAX_LENGTH);
}
