import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Check if any user exists.
 */
export async function hasUser(databaseUrl: string): Promise<boolean> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const result = await client`SELECT count(*)::int AS count FROM users`;
    return (result[0] as { count: number }).count > 0;
  } finally {
    await client.end();
  }
}

/**
 * Create the initial admin user + organization + member + human agent.
 * Used during first-run onboard. Returns the generated password.
 *
 * Note: the function name was renamed from `createOwner` after the design
 * spotted a schema mismatch — `members.role` is `"admin" | "member"`, not
 * `"owner"`, and the inserted row has always been `'admin'`.
 */
export async function createAdmin(
  databaseUrl: string,
  username: string,
  orgName: string,
  displayName: string,
  password?: string,
): Promise<{ username: string; password: string }> {
  const pw = password ?? randomBytes(12).toString("base64url");
  const hash = await bcrypt.hash(pw, 12);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  try {
    const userId = makeUuidV7();
    const orgId = makeUuidV7();
    const agentId = makeUuidV7();
    const memberId = makeUuidV7();

    const agentName = username.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO users (id, username, password_hash, display_name)
        VALUES (${userId}, ${username}, ${hash}, ${displayName})
      `);

      await tx.execute(sql`
        INSERT INTO organizations (id, name, display_name)
        VALUES (${orgId}, ${orgName}, ${displayName})
        ON CONFLICT DO NOTHING
      `);

      // agents.manager_id is NOT NULL after the unified-user-token milestone;
      // the FK is deferred so we can forward-reference the members row that
      // gets inserted below within the same transaction.
      await tx.execute(sql`
        INSERT INTO agents (uuid, name, organization_id, type, display_name, inbox_id, status, source, manager_id)
        VALUES (${agentId}, ${agentName}, ${orgId}, 'human', ${displayName}, ${`inbox_${agentId}`}, 'active', 'admin-api', ${memberId})
      `);

      await tx.execute(sql`
        INSERT INTO members (id, user_id, organization_id, agent_id, role)
        VALUES (${memberId}, ${userId}, ${orgId}, ${agentId}, 'admin')
      `);

      await tx.execute(sql`
        INSERT INTO agent_configs (agent_id, version, payload, updated_by)
        VALUES (${agentId}, 1, ${sql`'{"prompt":{"append":""},"model":"opus","mcpServers":[],"env":[],"gitRepos":[]}'::jsonb`}, 'system')
        ON CONFLICT (agent_id) DO NOTHING
      `);
    });
  } finally {
    await client.end();
  }

  return { username, password: pw };
}

/**
 * Identity tuple of the local admin — the human at this machine.
 *
 * `local-bootstrap` (Q7), the daemon's startup JWT recovery (B2), and
 * out-of-band CLI auth (B3) all need to answer the same question: "who is
 * the admin on this machine?". `findAdmin` is the single source of truth.
 */
export type LocalAdmin = {
  userId: string;
  memberId: string;
  organizationId: string;
  agentId: string;
};

/**
 * Resolve the local admin: earliest `members.role = 'admin'` row in the
 * `default` org. Returns null when no admin exists yet (the database has
 * been migrated but `createAdmin` has not run).
 *
 * Mirrors the server-side resolver in `services/auth.ts:localBootstrap`;
 * the two stay in lock-step so the daemon (B2) and the CLI both pick the
 * same row. The server-side path is covered by
 * `auth-local-bootstrap.test.ts`.
 */
export async function findAdmin(databaseUrl: string): Promise<LocalAdmin | null> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const rows = await client<
      Array<{
        user_id: string;
        member_id: string;
        organization_id: string;
        agent_id: string;
      }>
    >`
      SELECT u.id AS user_id, m.id AS member_id, m.organization_id, m.agent_id
      FROM members m
      JOIN users u ON u.id = m.user_id
      JOIN organizations o ON o.id = m.organization_id
      WHERE m.role = 'admin' AND o.name = 'default'
      ORDER BY m.created_at ASC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      memberId: row.member_id,
      organizationId: row.organization_id,
      agentId: row.agent_id,
    };
  } finally {
    await client.end();
  }
}

/** Generate a UUID v7 (time-ordered). Inline to avoid cross-package dependency. */
function makeUuidV7(): string {
  const now = BigInt(Date.now());
  const bytes = new Uint8Array(16);
  bytes[0] = Number((now >> 40n) & 0xffn);
  bytes[1] = Number((now >> 32n) & 0xffn);
  bytes[2] = Number((now >> 24n) & 0xffn);
  bytes[3] = Number((now >> 16n) & 0xffn);
  bytes[4] = Number((now >> 8n) & 0xffn);
  bytes[5] = Number(now & 0xffn);
  const rand = randomBytes(10);
  for (let i = 0; i < 10; i++) {
    const b = rand[i];
    if (b !== undefined) bytes[6 + i] = b;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
