/**
 * MIGRATION NOTE (2026-05-18): one-off smoke. Functionally a subset of what
 * `packages/e2e/` will cover once M2 lands chat-send + admin-API agent
 * creation; will be folded into `packages/e2e/src/tests/agent-add.e2e.test.ts`
 * then. Keep until then; do not extend. New cross-process scenarios go in
 * `packages/e2e/src/tests/`. Source proposal:
 * `proposals/hub-local-e2e-framework.20260518.md`.
 *
 * End-to-end verification for the auto agent-add fix.
 *
 *   1. Create a fresh database in the already-running local Postgres so state
 *      never bleeds into the operator's production hub schema.
 *   2. Migrate the schema, start the real Fastify app on a random port.
 *   3. Seed an admin user + owned client (bypassing the CLI onboarding wizard).
 *   4. Start a real `ClientRuntime` pointing at that server (isolated home
 *      under a temp dir so it cannot clobber the operator's real config).
 *   5. Hit `POST /api/v1/admin/agents` with the seeded client as `clientId`.
 *   6. Assert that:
 *        - The runtime's local `agents/<name>/agent.yaml` was written — same
 *          file `first-tree-hub agent add` would produce.
 *        - A bound AgentSlot is running for that agentId (i.e. we did not
 *          just drop the event on the floor).
 *
 * Run from the `apps/cli` directory:
 *   docker compose up -d                           # start local Postgres
 *   pnpm tsx scripts/e2e-auto-agent-add.ts         # run the e2e script
 *
 * Exits non-zero on failure and prints a readable summary either way.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import postgres from "postgres";

// ── Step 1: Temp home — must be exported BEFORE anything reads it. ───────────

const TEST_HOME = join(tmpdir(), `ft-hub-e2e-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`);
mkdirSync(join(TEST_HOME, "config"), { recursive: true });
process.env.FIRST_TREE_HOME = TEST_HOME;

const jwtSecret = "e2e-jwt-secret-key-for-auto-agent-add";

async function signMemberJwt(userId: string, memberId: string, organizationId: string, role: string): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: userId,
    memberId,
    organizationId,
    role,
    type: "access",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(secret);
}

// Reach into the already-running local Postgres and provision a fresh database
// for this run. We drop it on teardown so repeat runs stay clean.
const ADMIN_URL = process.env.E2E_PG_ADMIN_URL ?? "postgresql://firsttreehub:firsttreehub@localhost:5432/postgres";
const dbSuffix = crypto.randomUUID().slice(0, 8).replace(/-/g, "");
const TEST_DB_NAME = `ft_hub_e2e_${dbSuffix}`;

async function provisionFreshDb(): Promise<string> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    // Unsafe is OK here — TEST_DB_NAME is a generated random identifier.
    await admin.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}

async function dropDb(): Promise<void> {
  const admin = postgres(ADMIN_URL, { max: 1 });
  try {
    // Kick any lingering sessions so DROP can proceed.
    await admin.unsafe(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB_NAME}' AND pid <> pg_backend_pid()`,
    );
    await admin.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  let passed = true;
  const teardown: Array<() => Promise<void>> = [];

  log(`  ▶ Temp home: ${TEST_HOME}`);
  log(`  ▶ Provisioning fresh Postgres database: ${TEST_DB_NAME}`);

  let databaseUrl: string;
  try {
    databaseUrl = await provisionFreshDb();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`  ✗ Cannot create test DB — is local Postgres running? (${msg})`);
    log("    Start it with: docker compose up -d");
    process.exit(2);
  }
  teardown.push(async () => {
    await dropDb();
  });

  process.env.DATABASE_URL = databaseUrl;
  process.env.JWT_SECRET = jwtSecret;

  log("  ▶ Running migrations…");
  execSync("pnpm --filter @first-tree/server db:migrate", {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "pipe",
  });

  // Dynamic imports so DATABASE_URL / FIRST_TREE_HOME are set before
  // modules first read them.
  const { buildApp } = await import("../../server/src/app.js");
  const { createAgent } = await import("../../server/src/services/agent.js");
  const { resolveDefaultOrgId } = await import("../../server/src/services/organization.js");
  const { users } = await import("../../server/src/db/schema/users.js");
  const { members } = await import("../../server/src/db/schema/members.js");
  const { clients } = await import("../../server/src/db/schema/clients.js");
  const { uuidv7 } = await import("../../server/src/uuid.js");

  const app = await buildApp({
    database: { url: databaseUrl, provider: "external" },
    server: { port: 0, host: "127.0.0.1" },
    secrets: {
      jwtSecret,
      encryptionKey: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    },
    rateLimit: { max: 10000, loginMax: 10000, webhookMax: 10000 },
    instanceId: "e2e-instance",
    logger: false,
  });
  await app.ready();
  await app.listen({ port: 0, host: "127.0.0.1" });
  teardown.push(async () => {
    await app.close();
  });

  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no server address");
  const serverUrl = `http://127.0.0.1:${addr.port}`;
  log(`  ✓ Server up at ${serverUrl}`);

  // ── Step 3: Seed user/member/client ─────────────────────────────────────────
  const orgId = await resolveDefaultOrgId(app.db);
  const userId = uuidv7();
  const memberId = uuidv7();
  const clientId = `cli-e2e-${crypto.randomUUID().slice(0, 6)}`;

  await app.db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      username: `e2e-user-${crypto.randomUUID().slice(0, 6)}`,
      passwordHash: "x",
      displayName: "E2E User",
    });

    const humanAgent = await createAgent(tx as unknown as typeof app.db, {
      name: `e2e-human-${crypto.randomUUID().slice(0, 6)}`,
      type: "human",
      displayName: "E2E Human",
      source: "admin-api",
      managerId: memberId,
      organizationId: orgId,
    });

    await tx.insert(members).values({
      id: memberId,
      userId,
      organizationId: orgId,
      agentId: humanAgent.uuid,
      role: "admin",
    });

    await tx.insert(clients).values({
      id: clientId,
      userId,
      status: "connected",
    });
  });

  const accessToken = await signMemberJwt(userId, memberId, orgId, "admin");
  log(`  ✓ Seeded client_id=${clientId} owned by user ${userId.slice(0, 8)}…`);

  // ── Step 4: Drop in credentials.json + client.yaml so ensureFreshAccessToken
  // and resolveServerUrl find what they need. ClientRuntime calls
  // ensureFreshAccessToken on every WS handshake. ────────────────────────────
  writeFileSync(
    join(TEST_HOME, "config", "credentials.json"),
    JSON.stringify({ accessToken, refreshToken: "e2e-refresh", serverUrl }, null, 2),
  );
  writeFileSync(join(TEST_HOME, "config", "client.yaml"), `server:\n  url: ${serverUrl}\n`);

  // ── Step 5: Start a real ClientRuntime against the test server. ────────────
  const { ClientRuntime } = await import("../src/core/client-runtime.js");

  const agentsDir = join(TEST_HOME, "config", "agents");
  mkdirSync(agentsDir, { recursive: true });

  const runtime = new ClientRuntime(serverUrl, clientId);
  runtime.watchAgentsDir(agentsDir);
  await runtime.start();
  teardown.push(async () => {
    await runtime.stop();
  });
  log("  ✓ ClientRuntime connected + client:register acknowledged");

  // ── Step 6: Create an agent via admin API with clientId pinned. ────────────
  const agentName = `e2e-auto-${crypto.randomUUID().slice(0, 6)}`;
  log(`  ▶ POST /admin/agents { name: ${agentName}, clientId: ${clientId} }`);

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/admin/agents",
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: agentName,
      type: "autonomous_agent",
      displayName: "E2E Auto Agent",
      clientId,
    },
  });
  if (res.statusCode !== 201) {
    throw new Error(`Create agent failed: ${res.statusCode} ${res.payload}`);
  }
  const body = res.json<{ uuid: string; name: string; clientId: string | null }>();
  log(`  ✓ Agent created: uuid=${body.uuid}`);

  // ── Step 7: Wait for the handler to write the local yaml file. ─────────────
  const expectedYaml = join(agentsDir, agentName, "agent.yaml");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(expectedYaml)) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  if (!existsSync(expectedYaml)) {
    log(`  ✗ FAIL: expected ${expectedYaml} to be created by handleAgentPinned — not found.`);
    passed = false;
  } else {
    const content = readFileSync(expectedYaml, "utf-8");
    log(`  ✓ File written: ${expectedYaml}`);
    log(`    ${content.trim().replace(/\n/g, "\n    ")}`);
    if (!content.includes(body.uuid)) {
      log(`  ✗ FAIL: yaml does not contain agentId ${body.uuid}`);
      passed = false;
    }
  }

  // ── Step 8: Confirm the runtime actually bound the agent via the WS. ───────
  const activityDeadline = Date.now() + 5000;
  let bound = false;
  while (Date.now() < activityDeadline) {
    const activityRes = await app.inject({
      method: "GET",
      url: "/api/v1/admin/agents/activity",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (activityRes.statusCode === 200) {
      const data = activityRes.json<{ agents: Array<{ agentId: string; clientId: string | null }> }>();
      if (data.agents.some((a) => a.agentId === body.uuid && a.clientId === clientId)) {
        bound = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (bound) {
    log(`  ✓ Agent ${body.uuid} is bound to client ${clientId} (presence visible via activity).`);
  } else {
    log("  ✗ FAIL: agent never appeared bound in the activity roster within 5s.");
    passed = false;
  }

  // ── Step 9: Second scenario — PATCH NULL → clientId must also auto-add. ────
  log("");
  log("  ▶ Scenario 2: create agent without clientId, then PATCH it to bind");

  const unboundAgent = await createAgent(app.db, {
    name: `e2e-bind-${crypto.randomUUID().slice(0, 6)}`,
    type: "autonomous_agent",
    displayName: "E2E Bind Agent",
    source: "admin-api",
    managerId: memberId,
    organizationId: orgId,
  });
  if (unboundAgent.clientId !== null) {
    log("  ✗ FAIL: expected unbound agent to have clientId=null initially.");
    passed = false;
  } else {
    log(`  ✓ Created unbound agent ${unboundAgent.uuid} (name=${unboundAgent.name})`);
  }

  const patchRes = await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/agents/${unboundAgent.uuid}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { clientId },
  });
  if (patchRes.statusCode !== 200) {
    log(`  ✗ FAIL: PATCH bind returned ${patchRes.statusCode} — ${patchRes.payload}`);
    passed = false;
  } else {
    log(`  ✓ PATCH /admin/agents/${unboundAgent.uuid} { clientId } returned 200`);
  }

  const bindYaml = join(agentsDir, unboundAgent.name ?? "", "agent.yaml");
  const bindDeadline = Date.now() + 5000;
  while (Date.now() < bindDeadline) {
    if (existsSync(bindYaml)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!existsSync(bindYaml)) {
    log(`  ✗ FAIL: expected ${bindYaml} after PATCH bind — not found.`);
    passed = false;
  } else {
    const content = readFileSync(bindYaml, "utf-8");
    log(`  ✓ File written: ${bindYaml}`);
    log(`    ${content.trim().replace(/\n/g, "\n    ")}`);
    if (!content.includes(unboundAgent.uuid)) {
      log(`  ✗ FAIL: yaml does not contain agentId ${unboundAgent.uuid}`);
      passed = false;
    }
  }

  // ── Teardown (reverse order). ──────────────────────────────────────────────
  for (const fn of [...teardown].reverse()) {
    try {
      await fn();
    } catch {
      // best-effort
    }
  }
  rmSync(TEST_HOME, { recursive: true, force: true });

  process.stderr.write("\n");
  if (passed) {
    process.stderr.write("  ✅ E2E PASSED — auto agent-add via agent:pinned works end to end.\n\n");
    process.exit(0);
  } else {
    process.stderr.write("  ❌ E2E FAILED — see log above.\n\n");
    process.exit(1);
  }
}

main().catch(async (err) => {
  process.stderr.write(`\n  ❌ E2E CRASHED: ${err instanceof Error ? err.stack : String(err)}\n\n`);
  try {
    await dropDb();
  } catch {
    // ignore
  }
  process.exit(2);
});
