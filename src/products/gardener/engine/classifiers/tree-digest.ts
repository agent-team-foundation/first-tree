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

const DIGEST_BUDGET_BYTES = 30_000;
const PER_NODE_SUMMARY_CAP = 400;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".first-tree",
  ".claude",
  ".agents",
  "dist",
  "build",
  "tmp",
]);

export function collectTreeDigest(treeRoot: string): TreeNodeEntry[] {
  const out: TreeNodeEntry[] = [];
  let bytes = 0;
  let exhausted = false;
  const walk = (dir: string): void => {
    if (exhausted) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (exhausted) return;
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
      const cost = entry.path.length + entry.summary.length + 4;
      if (bytes + cost > DIGEST_BUDGET_BYTES) {
        exhausted = true;
        return;
      }
      bytes += cost;
      out.push(entry);
    }
  };
  walk(treeRoot);
  return out;
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
