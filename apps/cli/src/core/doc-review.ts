import { basename } from "node:path";

/**
 * Document review (docloop) CLI helpers — the pure logic behind the `doc`
 * namespace commands (apps/cli/src/commands/doc/).
 */

/**
 * Derive a publishable slug from a file path: basename without the extension,
 * lowercased, with every non-alphanumeric run collapsed to a single "-".
 * Returns null when nothing slug-like survives (e.g. "---.md").
 */
export function slugFromFilename(filePath: string): string | null {
  const base = basename(filePath).replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * Derive a title from markdown content: the first ATX heading wins,
 * whatever its level. Returns null when the document has no heading.
 */
export function titleFromMarkdown(content: string): string | null {
  for (const line of content.split("\n")) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (match?.[1]) return match[1];
  }
  return null;
}
