/**
 * Fixture: establish one agent-authored request for the fresh user's Need you
 * queue.
 *
 * The browser suite cannot make the fixture agent's runtime author a request:
 * seed-agent-online.js mirrors presence but does not start an agent process.
 * This script therefore mirrors the durable writes made by a real request
 * send. It creates only the initial condition. The user's option selection,
 * resolving message, human-only authorization, open-question lifecycle, and
 * queue refresh are exercised through the real web and server paths.
 *
 * Requires GH_ID / GH_LOGIN from new-test-identity.js and DATABASE_URL from the
 * Momentic local environment.
 */
const clientId = `e2e-client-${env.GH_ID}`;
const requestId = `p0-need-you-${env.GH_ID}`;
const question = "Which P0 flow should the team validate next?";
const requestMetadata = {
  request: {
    options: [
      {
        label: "Workspace flow",
        description: "Validate the daily workspace work loop next.",
      },
      {
        label: "Onboarding flow",
        description: "Validate the first-run activation journey next.",
      },
    ],
    multiSelect: false,
  },
};

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  const { rows } = await db.query(
    `SELECT m.agent_id AS human_agent_id,
            m.organization_id,
            a.uuid AS asker_agent_id,
            c.id AS chat_id
       FROM users u
       JOIN members m
         ON m.user_id = u.id
        AND m.status = 'active'
       JOIN agents a
         ON a.organization_id = m.organization_id
        AND a.client_id = $2
        AND a.type = 'agent'
        AND a.status = 'active'
       JOIN chats c
         ON c.organization_id = m.organization_id
        AND c.onboarding_kickoff_key = m.agent_id || ':' || a.uuid || ':onboarding'
       JOIN chat_membership human_cm
         ON human_cm.chat_id = c.id
        AND human_cm.agent_id = m.agent_id
       JOIN chat_membership agent_cm
         ON agent_cm.chat_id = c.id
        AND agent_cm.agent_id = a.uuid
      WHERE u.username = $1
      LIMIT 1`,
    [env.GH_LOGIN, clientId],
  );
  const context = rows[0];
  if (!context) {
    throw new Error(`No completed onboarding chat for ${env.GH_LOGIN}`);
  }

  requestMetadata.mentions = [context.human_agent_id];

  await db.query("BEGIN");
  try {
    await db.query(
      `INSERT INTO messages
         (id, chat_id, sender_id, format, content, metadata, source, created_at)
       VALUES ($1, $2, $3, 'request', $4::jsonb, $5::jsonb, 'api', NOW())
       ON CONFLICT (id) DO UPDATE
         SET content = EXCLUDED.content,
             metadata = EXCLUDED.metadata`,
      [requestId, context.chat_id, context.asker_agent_id, JSON.stringify(question), JSON.stringify(requestMetadata)],
    );
    await db.query(
      `UPDATE chats
          SET last_message_at = NOW(),
              last_message_preview = $2,
              activity_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [context.chat_id, question],
    );
    await db.query(
      `INSERT INTO chat_user_state
         (chat_id, agent_id, unread_mention_count, open_request_count, engagement_status)
       VALUES ($1, $2, 1, 1, 'active')
       ON CONFLICT (chat_id, agent_id) DO UPDATE
         SET unread_mention_count = GREATEST(chat_user_state.unread_mention_count, 1),
             open_request_count = 1,
             engagement_status = 'active'`,
      [context.chat_id, context.human_agent_id],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  return requestId;
} finally {
  await db.end();
}
