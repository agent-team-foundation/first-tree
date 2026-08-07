/**
 * Fixture: give the disposable onboarding user two real Workspace chats with
 * distinct current-state descriptions.
 *
 * The onboarding module has already created the user, Team, human agent,
 * coding agent, and first chat through product APIs. This fixture changes only
 * the data needed to exercise chat switching: it gives that existing chat a
 * summary and inserts one additional chat with the same two speakers. The web
 * app still loads both chats and their descriptions through the real server.
 *
 * Requires GH_LOGIN from new-test-identity.js and DATABASE_URL from the local
 * Momentic environment. The generated chat id is scoped to that disposable
 * identity, so parallel or repeated runs cannot collide with valuable data.
 */
const summaryChatId = `e2e-summary-${env.GH_ID}`;

const firstDescription = [
  "Chat Summary hierarchy is ready in the real Workspace.",
  "",
  "The result leads, supporting context stays quieter, and the copy uses a scan-friendly reading measure.",
  "",
  "**Next:** Switch chats and confirm the selected chat's state replaces this one.",
].join("\n");

const secondDescription = [
  "Mobile navigation polish is awaiting product review.",
  "",
  "The implementation is complete, but the final interaction choice still needs a decision.",
  "",
  "**Next:** Review the compact navigation behavior.",
].join("\n");

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  const { rows } = await db.query(
    `SELECT m.organization_id,
            m.agent_id AS human_agent_id,
            a.uuid AS coding_agent_id,
            c.id AS kickoff_chat_id
       FROM users u
       JOIN members m
         ON m.user_id = u.id
        AND m.status = 'active'
       JOIN agents a
         ON a.manager_id = m.id
        AND a.type = 'agent'
        AND a.status = 'active'
       JOIN chat_membership hm
         ON hm.agent_id = m.agent_id
        AND hm.access_mode = 'speaker'
       JOIN chats c
         ON c.id = hm.chat_id
        AND c.organization_id = m.organization_id
      WHERE u.username = $1
      ORDER BY c.created_at DESC, a.created_at DESC
      LIMIT 1`,
    [env.GH_LOGIN],
  );
  const fixture = rows[0];
  if (!fixture) throw new Error(`No onboarding chat found for ${env.GH_LOGIN}`);

  await db.query("BEGIN");
  await db.query(
    `UPDATE chats
        SET topic = 'Summary rollout validation',
            description = $1,
            description_updated_at = NOW(),
            activity_at = NOW(),
            updated_at = NOW()
      WHERE id = $2`,
    [firstDescription, fixture.kickoff_chat_id],
  );
  await db.query(
    `INSERT INTO chats
       (id, organization_id, type, topic, description, description_updated_at,
        lifecycle_policy, metadata, activity_at, created_at, updated_at)
     VALUES
       ($1, $2, 'group', 'Mobile navigation polish', $3, NOW(),
        'persistent', '{}'::jsonb, NOW() + INTERVAL '1 second', NOW(), NOW())`,
    [summaryChatId, fixture.organization_id, secondDescription],
  );
  await db.query(
    `INSERT INTO chat_membership
       (chat_id, agent_id, role, access_mode, mode, source)
     VALUES
       ($1, $2, 'owner', 'speaker', 'mention_only', 'manual'),
       ($1, $3, 'member', 'speaker', 'mention_only', 'manual')`,
    [summaryChatId, fixture.human_agent_id, fixture.coding_agent_id],
  );
  await db.query("COMMIT");

  setVariable("SUMMARY_CHAT_ID", summaryChatId);
  return summaryChatId;
} catch (error) {
  await db.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await db.end();
}
