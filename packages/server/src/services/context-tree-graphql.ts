import { sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";

const GRAPHQL_URL = "https://api.github.com/graphql";

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

/**
 * Fetch all members from a Context Tree repo via GitHub GraphQL API.
 * Single request regardless of member count.
 */
async function fetchMembers(repo: string, branch: string, token: string): Promise<MemberEntry[]> {
  const { owner, name } = parseRepo(repo);

  if (!owner || !name) throw new Error(`Invalid repo format: "${repo}" — expected "owner/repo" or a GitHub URL`);

  const query = `
    query($owner: String!, $name: String!, $expr: String!) {
      repository(owner: $owner, name: $name) {
        object(expression: $expr) {
          ... on Tree {
            entries {
              name
              type
              object {
                ... on Tree {
                  entries {
                    name
                    object { ... on Blob { text } }
                  }
                }
              }
            }
          }
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

  type GraphQLResponse = {
    data?: {
      repository?: {
        object?: {
          entries?: Array<{
            name: string;
            type: string;
            object?: {
              entries?: Array<{
                name: string;
                object?: { text?: string };
              }>;
            };
          }>;
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  const json = (await res.json()) as GraphQLResponse;

  if (json.errors) {
    throw new Error(`GitHub GraphQL errors: ${json.errors.map((e) => e.message).join(", ")}`);
  }

  const entries = json.data?.repository?.object?.entries ?? [];
  const members: MemberEntry[] = [];

  for (const entry of entries) {
    if (entry.type !== "tree") continue;
    const nodeFile = entry.object?.entries?.find((f) => f.name === "NODE.md");
    members.push({
      name: entry.name,
      nodeContent: nodeFile?.object?.text ?? null,
    });
  }

  return members;
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
        sql`SELECT id, status, type, display_name, delegate_mention FROM agents WHERE id = ${member.name}`,
      );

      if (existing.length === 0) {
        // New agent — create
        await db.execute(sql`
          INSERT INTO agents (id, type, display_name, delegate_mention, status, inbox_id)
          VALUES (${member.name}, ${meta.type}, ${meta.displayName}, ${meta.delegateMention}, 'active', ${`inbox_${member.name}`})
        `);
        result.created++;
      } else {
        const agent = existing[0] as {
          id: string;
          status: string;
          type: string;
          display_name: string | null;
          delegate_mention: string | null;
        };

        if (agent.status === "suspended") {
          // Reactivate — member is back in tree
          await db.execute(sql`
            UPDATE agents SET status = 'active', type = ${meta.type}, display_name = ${meta.displayName}, delegate_mention = ${meta.delegateMention}
            WHERE id = ${member.name}
          `);
          result.reactivated++;
        } else if (
          agent.type !== meta.type ||
          agent.display_name !== meta.displayName ||
          agent.delegate_mention !== meta.delegateMention
        ) {
          // Fields changed — update
          await db.execute(sql`
            UPDATE agents SET type = ${meta.type}, display_name = ${meta.displayName}, delegate_mention = ${meta.delegateMention}
            WHERE id = ${member.name}
          `);
          result.updated++;
        } else {
          result.unchanged++;
        }
      }
    } catch (err) {
      console.error(`[context-tree-sync] Failed to sync member "${member.name}":`, err);
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
