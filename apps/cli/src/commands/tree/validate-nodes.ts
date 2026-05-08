import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/su;
const OWNERS_RE = /^owners:\s*\[([^\]]*)\]/mu;
const SOFT_LINKS_INLINE_RE = /^soft_links:\s*\[([^\]]*)\]/mu;
const SOFT_LINKS_BLOCK_RE = /^soft_links:\s*\n((?:\s+-\s+.+\n?)+)/mu;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/mu;
// Personal path = a member's own subtree under `members/<me>/`.
// `members/NODE.md` itself is the members domain root and stays non-personal.
const PERSONAL_PATH_RE = /^members\/[^/]+\//u;

const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);
const SKIP_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
// Managed framework files that bootstrap writes as symlinks into `.agents/skills/`.
// They carry skill-payload frontmatter (`name:`/`version:`), not tree-node frontmatter
// (`title:`/`owners:`), so the node validator must not treat them as tree content.
const MANAGED_SYMLINK_FILES = new Set(["WHITEPAPER.md"]);

function rel(path: string, root: string): string {
  return relative(root, path).replace(/\\/gu, "/");
}

function shouldSkipPath(path: string, treeRoot: string): boolean {
  const relPath = rel(path, treeRoot);
  const parts = relPath.split("/");

  if (parts.some((part) => part.startsWith(".") || SKIP_DIRS.has(part))) {
    return true;
  }

  return false;
}

function collectMarkdownFiles(treeRoot: string): string[] {
  const files: string[] = [];

  function walk(dir: string): void {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      if (shouldSkipPath(fullPath, treeRoot)) {
        continue;
      }

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!stat.isFile() || !entry.endsWith(".md") || SKIP_FILES.has(entry)) {
          continue;
        }
        if (MANAGED_SYMLINK_FILES.has(entry) && lstatSync(fullPath).isSymbolicLink()) {
          continue;
        }
        files.push(fullPath);
      } catch {
        // Ignore unreadable entries.
      }
    }
  }

  walk(treeRoot);
  return files;
}

function parseFrontmatter(path: string): string | null {
  try {
    const text = readFileSync(path, "utf-8");
    const match = text.match(FRONTMATTER_RE);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function parseSoftLinks(frontmatter: string): string[] {
  const inlineMatch = frontmatter.match(SOFT_LINKS_INLINE_RE);
  if (inlineMatch) {
    return inlineMatch[1]
      .split(",")
      .map((value) => value.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean);
  }

  const blockMatch = frontmatter.match(SOFT_LINKS_BLOCK_RE);
  if (!blockMatch) {
    return [];
  }

  return blockMatch[1]
    .trim()
    .split("\n")
    .map((line) =>
      line
        .trim()
        .replace(/^-\s*/u, "")
        .trim()
        .replace(/^['"]|['"]$/gu, ""),
    )
    .filter(Boolean);
}

function resolveSoftLink(treeRoot: string, link: string): boolean {
  const cleaned = link.replace(/^\/+/u, "");
  const target = join(treeRoot, cleaned);

  try {
    if (statSync(target).isFile() && target.endsWith(".md")) {
      return true;
    }
  } catch {
    // Fall through.
  }

  try {
    return statSync(target).isDirectory() && existsSync(join(target, "NODE.md"));
  } catch {
    return false;
  }
}

export function runValidateNodes(treeRoot: string): {
  exitCode: number;
  errors: string[];
} {
  const errors: string[] = [];
  const markdownFiles = collectMarkdownFiles(treeRoot);

  for (const path of markdownFiles) {
    const relPath = rel(path, treeRoot);
    const personal = PERSONAL_PATH_RE.test(relPath);
    const frontmatter = parseFrontmatter(path);

    if (frontmatter === null) {
      // Personal files (`members/<me>/**`) may be plain markdown — the owner is
      // inferred from the path. Non-personal files still must declare frontmatter.
      if (!personal) {
        errors.push(`${relPath}: missing frontmatter`);
      }
      continue;
    }

    // Title and owners are required only outside personal paths. Inside
    // `members/<me>/**` the owner is the path-derived member; an explicit
    // `owners` field is optional and not cross-checked here.
    if (!personal) {
      if (!TITLE_RE.test(frontmatter)) {
        errors.push(`${relPath}: missing 'title' field in frontmatter`);
      }

      if (!OWNERS_RE.test(frontmatter)) {
        errors.push(`${relPath}: missing 'owners' field in frontmatter`);
      }
    }

    for (const softLink of parseSoftLinks(frontmatter)) {
      if (!resolveSoftLink(treeRoot, softLink)) {
        errors.push(`${relPath}: broken soft_links target '${softLink}'`);
      }
    }
  }

  return {
    exitCode: errors.length === 0 ? 0 : 1,
    errors,
  };
}
