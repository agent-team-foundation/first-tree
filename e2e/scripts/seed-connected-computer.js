/**
 * Fixture: stand in for a First Tree client daemon running on the user's computer.
 *
 * Onboarding step 2 ("Connect this computer") only lets the user continue once
 * `GET /me/clients` returns a client with status "connected" that reports a
 * ready runtime provider. In a real session that row is written by the daemon
 * over its WebSocket after the user runs the bootstrap command. A browser-driven
 * test has no second machine and no provider CLI to install, so the row is
 * seeded here — the fixture replaces the machine, not the product behaviour
 * under test. Everything after this point is exercised for real.
 *
 * `last_seen_at` is dated forward on purpose: the server sweeps connected
 * clients whose heartbeat is older than `presenceCleanupSeconds` (60s default,
 * see `cleanupStaleClients` in packages/server/src/services/client.ts). Without
 * a heartbeat loop a "now" timestamp flips the row to disconnected mid-run and
 * the flow regresses to "Your computer isn't connected".
 *
 * Requires GH_ID / GH_LOGIN from new-test-identity.js and DATABASE_URL from the
 * environment.
 */
const clientId = `e2e-client-${env.GH_ID}`;
const capabilities = {
  "claude-code": {
    state: "ok",
    available: true,
    detectedAt: new Date().toISOString(),
  },
};

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  // The team is created by the click that precedes this step, so the membership
  // row can land a moment after the UI advances. Poll rather than assume.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { rows } = await db.query(
      `INSERT INTO clients (id, user_id, organization_id, status, hostname, os, sdk_version,
                            connected_at, last_seen_at, metadata)
       SELECT $1, u.id, m.organization_id, 'connected', $2, 'linux', '0.1.0',
              NOW(), NOW() + INTERVAL '30 minutes', $3::jsonb
         FROM users u
         JOIN members m ON m.user_id = u.id
        WHERE u.username = $4
       ON CONFLICT (id) DO UPDATE
          SET status = 'connected',
              last_seen_at = EXCLUDED.last_seen_at,
              metadata = EXCLUDED.metadata
       RETURNING id`,
      [clientId, "e2e-runner", JSON.stringify({ capabilities }), env.GH_LOGIN],
    );
    if (rows.length > 0) return rows[0].id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No org membership for ${env.GH_LOGIN} after 10s — did the create-team step run?`);
} finally {
  await db.end();
}
