import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type MemberNode, memberNodeSchema } from "@agent-hub/shared";
import matter from "gray-matter";

const AGENT_ID_REGEX = /^[a-z0-9_-]+$/;

export type MemberEntry = MemberNode & { id: string };

export type ReadMembersResult = {
  members: MemberEntry[];
  errors: Array<{ memberId: string; error: string }>;
};

/**
 * Scan the context tree members/ directory and parse each member's NODE.md frontmatter.
 * Skips the top-level members/NODE.md index file.
 */
export async function readMembers(treePath: string): Promise<ReadMembersResult> {
  const membersDir = join(treePath, "members");

  // Verify members/ directory exists
  const dirStat = await stat(membersDir).catch(() => null);
  if (!dirStat?.isDirectory()) {
    throw new Error(`members/ directory not found at ${membersDir}`);
  }

  const entries = await readdir(membersDir, { withFileTypes: true });
  const members: MemberEntry[] = [];
  const errors: ReadMembersResult["errors"] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const memberId = entry.name;

    // Validate directory name as agent ID
    if (!AGENT_ID_REGEX.test(memberId)) {
      errors.push({ memberId, error: `Invalid agent ID format: "${memberId}"` });
      continue;
    }

    const nodePath = join(membersDir, memberId, "NODE.md");
    let content: string;
    try {
      content = await readFile(nodePath, "utf-8");
    } catch {
      errors.push({ memberId, error: "NODE.md not found" });
      continue;
    }

    let frontmatter: Record<string, unknown>;
    try {
      const parsed = matter(content);
      frontmatter = parsed.data as Record<string, unknown>;
    } catch (err) {
      errors.push({ memberId, error: `Failed to parse NODE.md frontmatter: ${String(err)}` });
      continue;
    }

    const result = memberNodeSchema.safeParse(frontmatter);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
      errors.push({ memberId, error: `Invalid frontmatter: ${issues}` });
      continue;
    }

    members.push({ id: memberId, ...result.data });
  }

  return { members, errors };
}
