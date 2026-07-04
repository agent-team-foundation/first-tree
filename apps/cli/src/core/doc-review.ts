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
  // split + filter instead of a trim-dashes regex: every piece is matched by
  // one unambiguous quantifier, so runtime stays linear on adversarial names
  // (CodeQL js/polynomial-redos).
  const slug = base
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
  return slug.length > 0 ? slug : null;
}

/**
 * Derive a title from markdown content: the first ATX heading wins,
 * whatever its level. Returns null when the document has no heading.
 */
export function titleFromMarkdown(content: string): string | null {
  for (const line of content.split("\n")) {
    // trimEnd() + an unanchored-tail regex keeps matching linear: the lazy
    // `(.+?)\s*$` form backtracks quadratically on long whitespace runs
    // (CodeQL js/polynomial-redos).
    const match = line.trimEnd().match(/^#{1,6}[ \t]+(.+)$/);
    if (match?.[1]) return match[1];
  }
  return null;
}
