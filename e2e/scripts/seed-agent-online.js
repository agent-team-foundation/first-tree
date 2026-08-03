/**
 * Fixture: bring the agent created during onboarding online.
 *
 * After "Create agent" the flow waits for the new agent to report presence
 * before it offers "Start chat"; in a real session the daemon binds the agent
 * and heartbeats it. The fixture computer from seed-connected-computer.js is not
 * a real daemon, so without this the run would sit in the product's "taking
 * longer than usual to come online" fallback and never reach the end of
 * onboarding.
 *
 * `last_seen_at` is dated forward for the same reason as the client fixture —
 * the presence sweep marks stale agents offline.
 *
 * Requires GH_ID from new-test-identity.js and DATABASE_URL from the environment.
 */
const clientId = `e2e-client-${env.GH_ID}`;

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  // The agent is created by the click that precedes this step; poll until the
  // server has written the row rather than racing it.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { rows } = await db.query(
      `INSERT INTO agent_presence (agent_id, status, client_id, connected_at, last_seen_at,
                                   runtime_type, runtime_state)
       SELECT a.uuid, 'online', a.client_id, NOW(), NOW() + INTERVAL '30 minutes',
              a.runtime_provider, 'ready'
         FROM agents a
        WHERE a.client_id = $1
       ON CONFLICT (agent_id) DO UPDATE
          SET status = 'online',
              client_id = EXCLUDED.client_id,
              last_seen_at = EXCLUDED.last_seen_at
       RETURNING agent_id`,
      [clientId],
    );
    if (rows.length > 0) return rows[0].agent_id;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`No agent bound to ${clientId} after 10s — did the create-agent step run?`);
} finally {
  await db.end();
}
