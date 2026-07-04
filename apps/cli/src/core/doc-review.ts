import { basename } from "node:path";
import { docSlugSchema } from "@first-tree/shared";

/**
 * Document review (docloop) CLI helpers — the pure logic behind the `doc`
 * namespace commands (apps/cli/src/commands/doc/).
 */

/** Index-style files a directory import skips by default. */
const IMPORT_SKIP_NAMES = new Set(["node.md", "readme.md"]);

export type DocImportCandidate = { path: string; slug: string };
export type DocImportPlan = {
  candidates: DocImportCandidate[];
  skipped: Array<{ path: string; reason: string }>;
};

/**
 * Turn a directory listing into an import plan: one candidate per markdown
 * file with a derivable, unique slug. Index files (NODE.md / README.md —
 * tree-style directories carry them) and slug collisions are skipped with a
 * reason rather than silently dropped, so `--dry-run` shows the full story.
 */
export function planMarkdownImport(filePaths: string[]): DocImportPlan {
  const candidates: DocImportCandidate[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const taken = new Map<string, string>();
  for (const filePath of filePaths) {
    const name = basename(filePath).toLowerCase();
    if (!name.endsWith(".md")) {
      skipped.push({ path: filePath, reason: "not a markdown file" });
      continue;
    }
    if (IMPORT_SKIP_NAMES.has(name)) {
      skipped.push({ path: filePath, reason: "index file (NODE.md / README.md)" });
      continue;
    }
    const slug = slugFromFilename(filePath);
    if (!slug || !docSlugSchema.safeParse(slug).success) {
      skipped.push({ path: filePath, reason: "cannot derive a valid slug from the filename" });
      continue;
    }
    const holder = taken.get(slug);
    if (holder) {
      skipped.push({ path: filePath, reason: `slug "${slug}" already taken by ${holder}` });
      continue;
    }
    taken.set(slug, filePath);
    candidates.push({ path: filePath, slug });
  }
  return { candidates, skipped };
}

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
 * whatever its level. Lines inside fenced code blocks are skipped so a
 * `# comment` in a leading code sample is not mistaken for the title.
 * Returns null when the document has no heading.
 */
export function titleFromMarkdown(content: string): string | null {
  let inFence = false;
  for (const line of content.split("\n")) {
    // trimEnd() + an unanchored-tail regex keeps matching linear: the lazy
    // `(.+?)\s*$` form backtracks quadratically on long whitespace runs
    // (CodeQL js/polynomial-redos).
    const trimmed = line.trimEnd();
    if (/^ {0,3}(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = trimmed.match(/^#{1,6}[ \t]+(.+)$/);
    if (match?.[1]) return match[1];
  }
  return null;
}
