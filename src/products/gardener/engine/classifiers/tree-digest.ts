/**
 * Walk `treeRoot` for `NODE.md` files and build a compact digest the
 * Anthropic classifier can use to ground its verdict. The digest is
 * `path + description + first paragraph` per node, capped at
 * DIGEST_BUDGET_BYTES so large trees don't blow the prompt.
 *
 * This is intentionally a flat listing — no tree structure, no link
 * resolution. The model sees "here are the tree nodes that exist,
 * here is what each one is about" and can cite paths by string. We
 * verify cited paths against the filesystem downstream (see
 * validateTreeNodes) so hallucinated citations get dropped before
 * comment body construction.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface TreeNodeEntry {
  /** tree-root-relative path to the NODE.md file (POSIX slashes). */
  path: string;
  /** Frontmatter `description:` if present, else the first paragraph. */
  summary: string;
}

/**
 * Total byte budget for the tree digest embedded in the classifier
 * prompt. Raised from 100KB → 500KB (2026-04: Claude 4.5/4.6/4.7 give
 * us a 200K-token context, so the old budget was severely
 * over-conservative and was silently truncating nodes out of the
 * classifier's view on larger trees; see #343).
 *
 * 500KB covers ≈ 2700 NODE.md entries at ~180 B each, which is
 * comfortably beyond any realistic Context Tree. Still leaves headroom
 * for PR body (uncapped) + diff (200KB cap) + system prompt (~1.5KB)
 * under a 200K-token window (~800KB text).
 */
const DIGEST_BUDGET_BYTES = 500_000;
const PER_NODE_SUMMARY_CAP = 400;

/**
 * Regex that matches the summary text gardener auto-writes when
 * scaffolding `drift/<source-id>/.../NODE.md` placeholders during a
 * sync. These placeholders carry no decisions — they exist only to let
 * a proposal PR have a valid parent chain — so feeding them to the
 * classifier wastes budget and clutters citations. See #343.
 */
const DRIFT_PLACEHOLDER_SUMMARY =
  /^Auto-generated intermediate node for sync proposals\.?$/i;

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".first-tree",
  ".claude",
  ".agents",
  // `.gardener-tree-cache` holds gardener's own per-sweep snapshot of
  // the tree as it was at the last reconciled source commit. Those
  // entries are stale duplicates of real NODE.md files; including
  // them in the digest double-counts every node under each sourceId
  // and pushes real nodes out of a tight budget. See #343.
  ".gardener-tree-cache",
  "dist",
  "build",
  "tmp",
]);

export interface CollectTreeDigestResult {
  entries: TreeNodeEntry[];
  /** Nodes that matched on-disk but were filtered as noise before budget check. */
  skippedAsNoise: number;
  /** Nodes dropped because the budget was exhausted. */
  truncatedCount: number;
  /** True when we stopped walking the tree because DIGEST_BUDGET_BYTES filled up. */
  budgetExhausted: boolean;
}

export function collectTreeDigest(treeRoot: string): TreeNodeEntry[] {
  return collectTreeDigestDetailed(treeRoot).entries;
}

/**
 * Same walk as {@link collectTreeDigest} but returns diagnostics the
 * caller can surface (e.g. "tree digest truncated at N nodes — budget
 * exhausted; consider raising DIGEST_BUDGET_BYTES"). Prefer this when
 * running inside a classifier that can log a warning. Kept as a
 * separate entry point so existing callers don't have to adopt the
 * richer shape.
 */
export function collectTreeDigestDetailed(
  treeRoot: string,
): CollectTreeDigestResult {
  const out: TreeNodeEntry[] = [];
  let bytes = 0;
  let budgetExhausted = false;
  let skippedAsNoise = 0;
  let truncatedCount = 0;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (name !== "NODE.md") continue;
      const entry = readNodeFile(full, treeRoot);
      if (!entry) continue;
      // Drop auto-generated drift-proposal placeholders before they
      // eat budget. They carry no decision signal.
      if (DRIFT_PLACEHOLDER_SUMMARY.test(entry.summary)) {
        skippedAsNoise += 1;
        continue;
      }
      const cost = entry.path.length + entry.summary.length + 4;
      if (bytes + cost > DIGEST_BUDGET_BYTES) {
        budgetExhausted = true;
        truncatedCount += 1;
        continue;
      }
      bytes += cost;
      out.push(entry);
    }
  };
  walk(treeRoot);
  return { entries: out, skippedAsNoise, truncatedCount, budgetExhausted };
}

function readNodeFile(
  full: string,
  treeRoot: string,
): TreeNodeEntry | null {
  let text: string;
  try {
    text = readFileSync(full, "utf-8");
  } catch {
    return null;
  }
  const rel = relative(treeRoot, full).split(sep).join("/");
  const summary = extractSummary(text);
  return { path: rel, summary };
}

function extractSummary(text: string): string {
  const fm = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fm) {
    const desc = fm[1].match(/^description\s*:\s*(.+?)\s*$/m);
    if (desc) return trimSummary(stripQuotes(desc[1]));
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const paragraphs = body.split(/\n\s*\n/);
  for (const p of paragraphs) {
    const stripped = p.replace(/^#+\s+.*$/gm, "").trim();
    if (stripped.length > 0) return trimSummary(stripped.replace(/\s+/g, " "));
  }
  return "";
}

function stripQuotes(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function trimSummary(s: string): string {
  if (s.length <= PER_NODE_SUMMARY_CAP) return s;
  return s.slice(0, PER_NODE_SUMMARY_CAP - 1) + "…";
}

export function formatDigest(entries: TreeNodeEntry[]): string {
  if (entries.length === 0) return "(no NODE.md files found)";
  return entries.map((e) => `- \`${e.path}\` — ${e.summary}`).join("\n");
}

/**
 * Surface tree-digest health info on the logging sink. Two things we
 * want visible without flipping a debug flag:
 *
 *   - noise filter actually removed nodes (worth knowing because it
 *     tells the operator their tree has ignorable auto-generated
 *     `drift/` placeholders; silent filtering would be confusing)
 *   - budget was exhausted (nodes silently dropped pre-#343); this is
 *     a correctness-affecting event — the classifier's verdict is
 *     judged against a truncated tree view and can cite the wrong
 *     nodes as "closest match."
 *
 * Shared between the claude-cli and anthropic-api classifiers so both
 * speak the same warning vocabulary.
 */
export function emitDigestDiagnostics(
  detailed: CollectTreeDigestResult,
  write: (line: string) => void,
): void {
  if (detailed.skippedAsNoise > 0) {
    write(
      `gardener: tree digest filtered ${detailed.skippedAsNoise} drift placeholder node(s) (auto-generated by prior sync)`,
    );
  }
  if (detailed.budgetExhausted) {
    write(
      `gardener: tree digest budget exhausted — ${detailed.truncatedCount} node(s) dropped. Verdict may miss relevant tree context. Consider pruning the tree or raising DIGEST_BUDGET_BYTES.`,
    );
  }
}
