import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

const GRAPHQL_URL = "https://api.github.com/graphql";
const REST_API_URL = "https://api.github.com";

/** Parse "owner/repo" or "https://github.com/owner/repo" into { owner, name }. */
export function parseRepo(input: string): { owner: string; name: string } {
  // Full URL: https://github.com/owner/repo or https://github.com/owner/repo.git
  const urlMatch = /github\.com\/([^/]+)\/([^/.]+)/.exec(input);
  if (urlMatch) {
    return { owner: urlMatch[1] ?? "", name: urlMatch[2] ?? "" };
  }
  // Short form: owner/repo
  const parts = input.split("/");
  return { owner: parts[0] ?? "", name: parts[1] ?? "" };
}

type MemberEntry = {
  name: string;
  treePath: string;
  nodeContent: string | null;
};

export type ContextTreeSyncResult = {
  created: number;
  updated: number;
  suspended: number;
  reactivated: number;
  unchanged: number;
  errors: number;
  syncedAt: string;
};

/** Step 1: Get the tree OID of the members/ directory via GraphQL. */
async function fetchMembersTreeOid(owner: string, name: string, branch: string, token: string): Promise<string | null> {
  const query = `
    query($owner: String!, $name: String!, $expr: String!) {
      repository(owner: $owner, name: $name) {
        object(expression: $expr) {
          ... on Tree { oid }
        }
      }
    }
  `;

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { owner, name, expr: `${branch}:members` },
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
  }

  type OidResponse = {
    data?: { repository?: { object?: { oid?: string } } };
    errors?: Array<{ message: string }>;
  };

  const json = (await res.json()) as OidResponse;
  if (json.errors) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  return json.data?.repository?.object?.oid ?? null;
}

type TreeEntry = {
  path: string;
  type: string;
  sha: string;
};

/** Step 2: Recursively list all entries under the members/ tree via REST API. */
async function fetchRecursiveTree(owner: string, name: string, treeSha: string, token: string): Promise<TreeEntry[]> {
  const url = `${REST_API_URL}/repos/${owner}/${name}/git/trees/${treeSha}?recursive=1`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub REST API returned ${res.status}: ${await res.text()}`);
  }

  type TreeResponse = {
    tree: Array<{ path: string; type: string; sha: string }>;
    truncated: boolean;
  };

  const json = (await res.json()) as TreeResponse;

  if (json.truncated) {
    throw new Error(
      "[context-tree-sync] GitHub REST tree API returned truncated response — members/ subtree is too large. Sync aborted to prevent incorrect agent suspension from partial data.",
    );
  }

  return json.tree;
}

/**
 * Step 3: Batch-fetch NODE.md content for all member directories via GraphQL aliases.
 * Each alias fetches one NODE.md file by expression.
 */
async function batchFetchNodeMd(
  owner: string,
  name: string,
  branch: string,
  memberPaths: string[],
  token: string,
): Promise<Map<string, string>> {
  if (memberPaths.length === 0) return new Map();

  // Build aliased query: m0: object(expression: "main:members/alice/NODE.md") { ...on Blob { text } }
  const aliases = memberPaths.map((p, i) => {
    const expr = `${branch}:members/${p}/NODE.md`;
    return `m${i}: object(expression: ${JSON.stringify(expr)}) { ... on Blob { text } }`;
  });

  const query = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        ${aliases.join("\n        ")}
      }
    }
  `;

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      variables: { owner, name },
    }),
  });

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
  }

  type BatchResponse = {
    data?: { repository?: Record<string, { text?: string } | null> };
    errors?: Array<{ message: string }>;
  };

  const json = (await res.json()) as BatchResponse;
  if (json.errors) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  const repo = json.data?.repository ?? {};
  const result = new Map<string, string>();
  for (let i = 0; i < memberPaths.length; i++) {
    const blob = repo[`m${i}`];
    const path = memberPaths[i];
    if (blob?.text && path) {
      result.set(path, blob.text);
    }
  }
  return result;
}

/**
 * Extract member directory paths from a recursive tree listing.
 * A directory is a member if it contains a NODE.md blob.
 */
function extractMemberDirs(treeEntries: TreeEntry[]): string[] {
  // Collect all NODE.md blob paths, then derive their parent directories
  const nodeMdPaths = new Set<string>();
  for (const entry of treeEntries) {
    if (entry.type === "blob" && entry.path.endsWith("/NODE.md")) {
      nodeMdPaths.add(entry.path);
    }
  }

  const memberDirs: string[] = [];
  for (const entry of treeEntries) {
    if (entry.type !== "tree") continue;
    // Check if this directory has a NODE.md
    if (nodeMdPaths.has(`${entry.path}/NODE.md`)) {
      memberDirs.push(entry.path);
    }
  }

  return memberDirs.sort();
}

/**
 * Fetch all members from a Context Tree repo via GitHub API.
 * Uses 3 API calls:
 *   1. GraphQL: get members/ tree OID
 *   2. REST: recursive tree listing (scoped to members/ only)
 *   3. GraphQL: batch-fetch all NODE.md contents via aliases
 */
async function fetchMembers(repo: string, branch: string, token: string): Promise<MemberEntry[]> {
  const { owner, name } = parseRepo(repo);

  if (!owner || !name) throw new Error(`Invalid repo format: "${repo}" — expected "owner/repo" or a GitHub URL`);

  // Step 1: Get members/ tree OID
  const treeOid = await fetchMembersTreeOid(owner, name, branch, token);
  if (!treeOid) {
    console.warn("[context-tree-sync] members/ directory not found in repo");
    return [];
  }

  // Step 2: Recursive tree listing (only members/ subtree)
  const treeEntries = await fetchRecursiveTree(owner, name, treeOid, token);

  // Step 3: Identify member directories (those with NODE.md)
  const memberDirs = extractMemberDirs(treeEntries);

  if (memberDirs.length === 0) {
    console.warn("[context-tree-sync] No member directories with NODE.md found");
    return [];
  }

  // Defensive check: duplicate directory names
  const nameMap = new Map<string, string>();
  for (const dir of memberDirs) {
    const dirName = dir.split("/").pop() ?? dir;
    const existing = nameMap.get(dirName);
    if (existing) {
      throw new Error(
        `[context-tree-sync] Duplicate member directory name '${dirName}' found at 'members/${existing}' and 'members/${dir}' — directory names must be unique across all levels under members/. Fix this in the Context Tree repo.`,
      );
    }
    nameMap.set(dirName, dir);
  }

  // Step 4: Batch-fetch NODE.md contents
  const nodeContents = await batchFetchNodeMd(owner, name, branch, memberDirs, token);

  return memberDirs.map((dir) => ({
    name: dir.split("/").pop() ?? dir,
    treePath: dir,
    nodeContent: nodeContents.get(dir) ?? null,
  }));
}

/** Parse NODE.md frontmatter for agent metadata. */
export function parseNodeMetadata(content: string): {
  type: string;
  displayName: string | null;
  delegateMention: string | null;
} {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) {
    return { type: "autonomous_agent", displayName: null, delegateMention: null };
  }

  const frontmatter = match[1] ?? "";
  const getValue = (key: string): string | null => {
    const lineMatch = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter);
    return lineMatch ? (lineMatch[1]?.trim().replace(/^["']|["']$/g, "") ?? null) : null;
  };

  return {
    type: getValue("type") ?? "autonomous_agent",
    displayName: getValue("display_name") ?? getValue("title") ?? getValue("name"),
    delegateMention: getValue("delegate_mention"),
  };
}

/** Stored for the /status endpoint */
let _lastSyncResult: ContextTreeSyncResult | undefined;

export function getLastGraphQLSyncResult(): ContextTreeSyncResult | undefined {
  return _lastSyncResult;
}

/**
 * Sync agents from a GitHub Context Tree repo via GraphQL.
 *
 * Lifecycle semantics:
 * - Member in tree, not in DB → create (active)
 * - Member in tree, in DB as active, fields changed → update
 * - Member in tree, in DB as active, fields unchanged → unchanged
 * - Member in tree, in DB as suspended → reactivate (set active)
 * - Agent in DB as active, NOT in tree → suspend
 */
export async function syncFromGitHub(
  db: Database,
  repo: string,
  branch: string,
  githubToken: string,
): Promise<ContextTreeSyncResult> {
  const members = await fetchMembers(repo, branch, githubToken);
  const memberNames = new Set(members.map((m) => m.name));

  const result: ContextTreeSyncResult = {
    created: 0,
    updated: 0,
    suspended: 0,
    reactivated: 0,
    unchanged: 0,
    errors: 0,
    syncedAt: new Date().toISOString(),
  };

  // Phase 1: Upsert members from tree
  for (const member of members) {
    try {
      const meta = member.nodeContent
        ? parseNodeMetadata(member.nodeContent)
        : { type: "autonomous_agent", displayName: null, delegateMention: null };

      const existing = await db.execute(
        sql`SELECT id, status, type, display_name, delegate_mention, tree_path FROM agents WHERE id = ${member.name}`,
      );

      if (existing.length === 0) {
        // New agent — create
        await db.execute(sql`
          INSERT INTO agents (id, type, display_name, delegate_mention, tree_path, status, inbox_id)
          VALUES (${member.name}, ${meta.type}, ${meta.displayName}, ${meta.delegateMention}, ${member.treePath}, 'active', ${`inbox_${member.name}`})
        `);
        result.created++;
      } else {
        const agent = existing[0] as {
          id: string;
          status: string;
          type: string;
          display_name: string | null;
          delegate_mention: string | null;
          tree_path: string | null;
        };

        if (agent.status === "suspended") {
          // Reactivate — member is back in tree
          await db.execute(sql`
            UPDATE agents SET status = 'active', type = ${meta.type}, display_name = ${meta.displayName}, delegate_mention = ${meta.delegateMention}, tree_path = ${member.treePath}
            WHERE id = ${member.name}
          `);
          result.reactivated++;
        } else if (
          agent.type !== meta.type ||
          agent.display_name !== meta.displayName ||
          agent.delegate_mention !== meta.delegateMention ||
          agent.tree_path !== member.treePath
        ) {
          // Fields changed — update
          await db.execute(sql`
            UPDATE agents SET type = ${meta.type}, display_name = ${meta.displayName}, delegate_mention = ${meta.delegateMention}, tree_path = ${member.treePath}
            WHERE id = ${member.name}
          `);
          result.updated++;
        } else {
          result.unchanged++;
        }
      }
    } catch (err) {
      console.error(
        `[context-tree-sync] Failed to sync member "${member.name}" (path: members/${member.treePath}):`,
        err,
      );
      result.errors++;
    }
  }

  // Phase 2: Suspend agents that are no longer in the tree
  // Skip managed agents (e.g. github-adapter) — they are created by the system, not the tree
  try {
    const activeAgents = await db.execute(
      sql`SELECT id FROM agents WHERE status = 'active' AND (metadata->>'managed')::boolean IS NOT TRUE`,
    );
    for (const row of activeAgents) {
      const agent = row as { id: string };
      if (!memberNames.has(agent.id)) {
        await db.execute(sql`UPDATE agents SET status = 'suspended' WHERE id = ${agent.id}`);
        result.suspended++;
      }
    }
  } catch (err) {
    console.error("[context-tree-sync] Failed to suspend removed agents:", err);
    result.errors++;
  }

  _lastSyncResult = result;
  return result;
}
