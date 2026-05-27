import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/su;
const VALID_TYPES = new Set(["human", "agent"]);
const VALID_STATUSES = new Set(["invited"]);

function rel(path: string, root: string): string {
  return relative(root, path).replace(/\\/gu, "/");
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

function extractScalar(fm: string, key: string): string | null {
  const regex = new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "mu");
  const match = fm.match(regex);
  return match ? match[1].trim() : null;
}

function extractList(fm: string, key: string): string[] | null {
  const inlineRegex = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "mu");
  const inlineMatch = fm.match(inlineRegex);

  if (inlineMatch) {
    const raw = inlineMatch[1].trim();
    if (!raw) {
      return [];
    }
    return raw
      .split(",")
      .map((value) => value.trim().replace(/^['"]|['"]$/gu, ""))
      .filter(Boolean);
  }

  const blockRegex = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "mu");
  const blockMatch = fm.match(blockRegex);

  if (!blockMatch) {
    return null;
  }

  return blockMatch[1]
    .trim()
    .split("\n")
    .filter((line) => line.trim())
    .map((line) =>
      line
        .trim()
        .replace(/^-\s*/u, "")
        .trim()
        .replace(/^['"]|['"]$/gu, ""),
    );
}

function validateMember(nodePath: string, treeRoot: string): string[] {
  const errors: string[] = [];
  const location = rel(nodePath, treeRoot);
  const fm = parseFrontmatter(nodePath);

  if (fm === null) {
    return [`${location}: no frontmatter found`];
  }

  const title = extractScalar(fm, "title");
  if (!title) {
    errors.push(`${location}: missing or empty 'title' field`);
  }

  const owners = extractList(fm, "owners");
  if (owners === null) {
    errors.push(`${location}: missing 'owners' field`);
  }

  const memberType = extractScalar(fm, "type");
  if (!memberType) {
    errors.push(`${location}: missing 'type' field`);
  } else if (!VALID_TYPES.has(memberType)) {
    errors.push(`${location}: invalid type '${memberType}' — must be one of: ${[...VALID_TYPES].sort().join(", ")}`);
  }

  const status = extractScalar(fm, "status");
  if (status !== null && !VALID_STATUSES.has(status)) {
    errors.push(`${location}: invalid status '${status}' — must be one of: ${[...VALID_STATUSES].sort().join(", ")}`);
  }

  const role = extractScalar(fm, "role");
  if (!role) {
    errors.push(`${location}: missing or empty 'role' field`);
  }

  const domains = extractList(fm, "domains");
  if (domains === null) {
    errors.push(`${location}: missing 'domains' field`);
  } else if (domains.length === 0) {
    errors.push(`${location}: 'domains' must contain at least one entry`);
  }

  return errors;
}

export function runValidateMembers(treeRoot: string): {
  exitCode: number;
  errors: string[];
} {
  const membersDir = join(treeRoot, "members");

  if (!existsSync(membersDir) || !statSync(membersDir).isDirectory()) {
    return {
      exitCode: 1,
      errors: [`Members directory not found: ${membersDir}`],
    };
  }

  const allErrors: string[] = [];
  let memberCount = 0;

  // Top-level directories under `members/` must each be a member node
  // (have NODE.md). Nested directories deeper than that are allowed to
  // exist as non-node containers — personal research notes, attachments,
  // assistants without a node yet, etc. Nested dirs that DO carry a
  // NODE.md are still validated as nested members (preserves the
  // `<member>/<member>-assistant/NODE.md` pattern).
  function walk(dir: string, requireNode: boolean): void {
    for (const child of readdirSync(dir).sort()) {
      const childPath = join(dir, child);

      try {
        if (!statSync(childPath).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }

      const nodePath = join(childPath, "NODE.md");
      if (!existsSync(nodePath)) {
        if (requireNode) {
          allErrors.push(`${rel(childPath, treeRoot)}/: directory exists but missing NODE.md`);
          walk(childPath, false);
        }
        continue;
      }

      memberCount += 1;
      allErrors.push(...validateMember(nodePath, treeRoot));
      walk(childPath, false);
    }
  }

  walk(membersDir, true);

  if (memberCount === 0) {
    allErrors.push("members/: no member nodes were found");
  }

  return {
    exitCode: allErrors.length === 0 ? 0 : 1,
    errors: allErrors,
  };
}
