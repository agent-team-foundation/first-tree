import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const VALID_TYPES = new Set(["human", "personal_assistant", "autonomous_agent"]);

function rel(path: string, root: string): string {
  return relative(root, path);
}

function parseFrontmatter(path: string): string | null {
  try {
    const text = readFileSync(path, "utf-8");
    const m = text.match(FRONTMATTER_RE);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function extractScalar(fm: string, key: string): string | null {
  const re = new RegExp(`^${key}:\\s*"?([^"\\n]+?)"?\\s*$`, "m");
  const m = fm.match(re);
  return m ? m[1].trim() : null;
}

export function extractList(fm: string, key: string): string[] | null {
  // Inline: key: [a, b]
  const inlineRe = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m");
  let m = fm.match(inlineRe);
  if (m) {
    const raw = m[1].trim();
    if (!raw) return [];
    return raw
      .split(",")
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }

  // Block: key:\n  - a\n  - b
  const blockRe = new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, "m");
  m = fm.match(blockRe);
  if (m) {
    return m[1]
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) =>
        line
          .trim()
          .replace(/^-\s*/, "")
          .trim()
          .replace(/^['"]|['"]$/g, ""),
      );
  }

  return null;
}

export function validateMember(
  nodePath: string,
  treeRoot: string,
): string[] {
  const errors: string[] = [];
  const loc = rel(nodePath, treeRoot);

  const fm = parseFrontmatter(nodePath);
  if (fm === null) return [`${loc}: no frontmatter found`];

  // title
  const title = extractScalar(fm, "title");
  if (!title) errors.push(`${loc}: missing or empty 'title' field`);

  // owners
  const owners = extractList(fm, "owners");
  if (owners === null) errors.push(`${loc}: missing 'owners' field`);

  // type
  const memberType = extractScalar(fm, "type");
  if (!memberType) {
    errors.push(`${loc}: missing 'type' field`);
  } else if (!VALID_TYPES.has(memberType)) {
    errors.push(
      `${loc}: invalid type '${memberType}' — must be one of: ${[...VALID_TYPES].sort().join(", ")}`,
    );
  }

  // role
  const role = extractScalar(fm, "role");
  if (!role) errors.push(`${loc}: missing or empty 'role' field`);

  // domains
  const domains = extractList(fm, "domains");
  if (domains === null) {
    errors.push(`${loc}: missing 'domains' field`);
  } else if (domains.length === 0) {
    errors.push(`${loc}: 'domains' must contain at least one entry`);
  }

  return errors;
}

export function runValidateMembers(treeRoot: string): {
  exitCode: number;
  errors: string[];
} {
  const membersDir = join(treeRoot, "members");
  if (!existsSync(membersDir) || !statSync(membersDir).isDirectory()) {
    console.log(`Members directory not found: ${membersDir}`);
    return { exitCode: 1, errors: [] };
  }

  const allErrors: string[] = [];
  let memberCount = 0;

  for (const child of readdirSync(membersDir).sort()) {
    const childPath = join(membersDir, child);

    // Reject stray .md files
    try {
      const stat = statSync(childPath);
      if (stat.isFile() && child.endsWith(".md") && child !== "NODE.md") {
        allErrors.push(
          `${rel(childPath, treeRoot)}: member must be a directory with NODE.md, not a standalone file — use members/${child.replace(/\.md$/, "")}/NODE.md instead`,
        );
        continue;
      }
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const nodePath = join(childPath, "NODE.md");
    if (!existsSync(nodePath)) {
      allErrors.push(`${rel(childPath, treeRoot)}/: directory exists but missing NODE.md`);
      continue;
    }
    memberCount++;
    allErrors.push(...validateMember(nodePath, treeRoot));
  }

  if (allErrors.length > 0) {
    console.log(`Found ${allErrors.length} member validation error(s):\n`);
    for (const err of allErrors) {
      console.log(`  \u2717 ${err}`);
    }
    return { exitCode: 1, errors: allErrors };
  }

  console.log(`All ${memberCount} member(s) passed validation.`);
  return { exitCode: 0, errors: allErrors };
}
