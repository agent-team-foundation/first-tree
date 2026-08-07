/**
 * Fixture: give the newly created Team a valid Context Tree binding.
 *
 * The browser journey under test starts after a Team already has a Context
 * Tree. Creating and authorizing a provider repository is a separate admin
 * journey, so this fixture writes only that prerequisite. The Settings page,
 * setup-prompt APIs, token generation, dialog, and clipboard interaction all
 * continue through the real app and server.
 *
 * Requires GH_LOGIN from new-test-identity.js and DATABASE_URL from the
 * environment.
 */
const binding = {
  provider: "github",
  repo: "https://github.com/agent-team-foundation/first-tree-context",
  branch: "main",
};

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  const { rows } = await db.query(
    `INSERT INTO organization_settings (organization_id, namespace, value, version, updated_by, updated_at)
     SELECT m.organization_id, 'context_tree', $1::jsonb, 0, u.id, NOW()
       FROM users u
       JOIN members m ON m.user_id = u.id
      WHERE u.username = $2
      ORDER BY m.created_at ASC
      LIMIT 1
     ON CONFLICT (organization_id, namespace) DO UPDATE
        SET value = EXCLUDED.value,
            version = organization_settings.version + 1,
            updated_by = EXCLUDED.updated_by,
            updated_at = EXCLUDED.updated_at
     RETURNING organization_id`,
    [JSON.stringify(binding), env.GH_LOGIN],
  );
  if (rows.length === 0) {
    throw new Error(`No org membership for ${env.GH_LOGIN} — did onboarding complete?`);
  }
  return rows[0].organization_id;
} finally {
  await db.end();
}
