import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { SignJWT } from "jose";
import { Client as PgClient } from "pg";

/**
 * E2E credentials helper — provisions the **minimum** set of rows needed for
 * a spawned `first-tree-hub daemon start --foreground` to authenticate +
 * register against the server, plus a `credentials.json` + `client.yaml` on
 * disk so the CLI picks them up as if the user had run `first-tree-hub
 * connect`. Direct PG writes are kept deliberately narrow:
 *
 *   1. `users`        — id, username, password_hash, display_name
 *   2. `agents` (human) — uuid, organization_id, type, display_name, inbox_id,
 *                         source, manager_id (in deferred-FK txn with members)
 *   3. `members`      — id, user_id, organization_id, agent_id, role
 *   4. `clients`      — id, user_id, organization_id
 *
 * Everything else on those tables (status, visibility, metadata,
 * runtime_provider, all timestamps) is left to DB defaults so a future
 * column addition doesn't silently break the fixture, and so the helper
 * never tells a lie about state it doesn't actually own. Anything beyond
 * this minimum — autonomous test agents, custom chats, runtime configs —
 * MUST go through the public HTTP API from the test that needs it; that
 * keeps server-side invariants (R-RUN, manager-in-org check, name regex)
 * exercised end-to-end instead of bypassed.
 *
 * Why direct PG at all: the server has no admin "create user" endpoint —
 * onboarding is human-driven OAuth + a connect-token UI, which a headless
 * e2e run can't replay. And packages/e2e is forbidden from importing
 * server source (biome `noRestrictedImports`), so we replicate the
 * minimum write path via `pg` + `jose` instead.
 */

export type ProvisionedCredentials = {
  userId: string;
  organizationId: string;
  memberId: string;
  /** Human agent representing the user in the org. */
  humanAgentId: string;
  /**
   * Lowercase `agents.name` of the human agent. Set to a unique-per-run
   * slug so tests that need to drive an `@mention` or PR assignee against
   * this agent (e.g. the github PR delivery test) can match it via the
   * audience resolver's `lower(agents.name) = login` filter. The agent
   * update API doesn't allow renaming, so the name has to be assigned
   * here at fixture insert time.
   */
  humanAgentName: string;
  /**
   * Pre-seeded `clients` row id. The spawned CLI's `client.yaml` is
   * planted with this same id so it claims the row on first WS register
   * (rather than inventing a fresh `client_<rand>`).
   */
  clientId: string;
  accessToken: string;
  refreshToken: string;
};

export type ProvisionOptions = {
  databaseUrl: string;
  jwtSecret: string;
  serverUrl: string;
  /** Per-run home dir; `${home}/config/{credentials.json,client.yaml}` will be written here. */
  home: string;
};

const ACCESS_TOKEN_EXPIRY = "30m";
const REFRESH_TOKEN_EXPIRY = "30d";

/**
 * Sentinel value for `users.password_hash`. The column is NOT NULL but we
 * never authenticate via password — tokens are minted directly. The value
 * is deliberately NOT bcrypt-shaped so a future `bcrypt.compare()` call
 * fails clearly instead of "succeeding" against a malformed hash.
 */
const E2E_PASSWORD_SENTINEL = "!e2e-fixture-no-password!";

export async function provisionTestCredentials(opts: ProvisionOptions): Promise<ProvisionedCredentials> {
  const userId = randomUUID();
  const memberId = randomUUID();
  const humanAgentId = randomUUID();
  const clientId = `client_${randomBytes(4).toString("hex")}`;
  const username = `e2e-${randomBytes(4).toString("hex")}`;
  // Use the username as the agent name — it already satisfies
  // AGENT_NAME_REGEX (`^[a-z0-9][a-z0-9_-]{0,63}$`) and is unique-per-run.
  const humanAgentName = username;

  let organizationId: string;
  const pg = new PgClient({ connectionString: opts.databaseUrl });
  await pg.connect();
  try {
    const orgRow = await pg.query<{ id: string }>("SELECT id FROM organizations WHERE name = 'default' LIMIT 1");
    const resolved = orgRow.rows[0]?.id;
    if (!resolved) {
      throw new Error(
        "Default organization not found — server boot should have called ensureDefaultOrganization(). " +
          "Make sure the server started successfully before provisioning credentials.",
      );
    }
    organizationId = resolved;

    // The agents.manager_id ↔ members.agent_id FK cycle is broken by the
    // deferred constraint added in migration 0019. A single BEGIN/COMMIT
    // lets both rows refer to each other; the FK is validated at commit.
    //
    // We deliberately do NOT set columns that already have defaults
    // (status, visibility, metadata, runtime_provider, created_at,
    // updated_at). If you find yourself adding a new column here, ask:
    // does the server itself REQUIRE it for the spawned client to
    // register? If no, leave it to the DB default.
    await pg.query("BEGIN");
    try {
      await pg.query("INSERT INTO users (id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)", [
        userId,
        username,
        E2E_PASSWORD_SENTINEL,
        "E2E Test User",
      ]);

      // `source` is left NULL — `admin-api` would be misleading; this row
      // didn't go through the admin API. `name` is set so tests can drive
      // `@mention` / PR-assignee flows against this human (see the
      // `github-pr-delivery` test).
      await pg.query(
        `INSERT INTO agents
           (uuid, name, organization_id, type, display_name, inbox_id, manager_id)
         VALUES ($1, $2, $3, 'human', $4, $5, $6)`,
        [humanAgentId, humanAgentName, organizationId, "E2E Test User", `inbox_${humanAgentId}`, memberId],
      );

      await pg.query(
        "INSERT INTO members (id, user_id, organization_id, agent_id, role) VALUES ($1, $2, $3, $4, 'admin')",
        [memberId, userId, organizationId, humanAgentId],
      );

      await pg.query("COMMIT");
    } catch (err) {
      await pg.query("ROLLBACK");
      throw err;
    }

    // Pre-seed the clients row so the spawned CLI's WS register CLAIMS this
    // id rather than INSERTing a fresh row. status / last_seen_at have
    // defaults; the WS handshake flips status to 'connected' on register.
    await pg.query("INSERT INTO clients (id, user_id, organization_id) VALUES ($1, $2, $3)", [
      clientId,
      userId,
      organizationId,
    ]);
  } finally {
    await pg.end();
  }

  const secret = new TextEncoder().encode(opts.jwtSecret);
  const accessToken = await new SignJWT({ sub: userId, type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(ACCESS_TOKEN_EXPIRY)
    .sign(secret);
  const refreshToken = await new SignJWT({ sub: userId, type: "refresh" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime(REFRESH_TOKEN_EXPIRY)
    .sign(secret);

  const configDir = resolve(opts.home, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });

  // Mirrors `apps/cli/src/core/bootstrap.ts::saveCredentials` shape.
  writeFileSync(
    resolve(configDir, "credentials.json"),
    JSON.stringify({ accessToken, refreshToken, serverUrl: opts.serverUrl }, null, 2),
    { mode: 0o600 },
  );

  // Plant the client.yaml so the spawned CLI's `initConfig` does NOT prompt
  // and uses our pre-seeded clients.id — otherwise it would invent a new
  // client_<rand> and any test that pins an agent to `clientId` would miss
  // the WS push.
  writeFileSync(resolve(configDir, "client.yaml"), `server:\n  url: ${opts.serverUrl}\nclient:\n  id: ${clientId}\n`, {
    mode: 0o600,
  });

  return {
    userId,
    organizationId,
    memberId,
    humanAgentId,
    humanAgentName,
    clientId,
    accessToken,
    refreshToken,
  };
}
