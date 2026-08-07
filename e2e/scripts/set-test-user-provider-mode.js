/**
 * Fixture: switch the fresh E2E user's provider shape without changing the
 * First Tree user, Team, membership, or browser session.
 *
 * The external GitHub OAuth UI cannot be driven with disposable credentials.
 * This fixture substitutes only that provider callback so the browser can
 * verify the Settings capability gate and its post-link return state against
 * the real server and web app.
 *
 * Requires GH_ID, GH_LOGIN, PROVIDER_MODE, and DATABASE_URL.
 */
const mode = env.PROVIDER_MODE;
if (mode !== "google-only" && mode !== "github-linked") {
  throw new Error(`Unsupported PROVIDER_MODE: ${mode}`);
}

const db = new pg.Client({ connectionString: env.DATABASE_URL });
await db.connect();
try {
  await db.query("BEGIN");
  const { rows: users } = await db.query(`SELECT id FROM users WHERE username = $1 LIMIT 1`, [env.GH_LOGIN]);
  const userId = users[0]?.id;
  if (!userId) throw new Error(`No E2E user found for ${env.GH_LOGIN}`);

  if (mode === "google-only") {
    await db.query(`DELETE FROM auth_identities WHERE user_id = $1 AND provider = 'github'`, [userId]);
    await db.query(
      `INSERT INTO auth_identities
         (id, user_id, provider, identifier, verified_at, metadata, created_at, updated_at)
       VALUES ($1, $2, 'google', $3, NOW(), $4::jsonb, NOW(), NOW())
       ON CONFLICT (user_id, provider) DO UPDATE
          SET identifier = EXCLUDED.identifier,
              verified_at = EXCLUDED.verified_at,
              metadata = EXCLUDED.metadata,
              updated_at = NOW()`,
      [
        `e2e-google-${env.GH_ID}`,
        userId,
        `e2e-google-subject-${env.GH_ID}`,
        JSON.stringify({ accountName: `e2e-google-${env.GH_ID}` }),
      ],
    );
  } else {
    await db.query(
      `INSERT INTO auth_identities
         (id, user_id, provider, identifier, verified_at, metadata, created_at, updated_at)
       VALUES ($1, $2, 'github', $3, NOW(), $4::jsonb, NOW(), NOW())
       ON CONFLICT (user_id, provider) DO UPDATE
          SET identifier = EXCLUDED.identifier,
              verified_at = EXCLUDED.verified_at,
              metadata = EXCLUDED.metadata,
              updated_at = NOW()`,
      [`e2e-github-${env.GH_ID}`, userId, env.GH_ID, JSON.stringify({ accountName: env.GH_LOGIN })],
    );
  }

  await db.query("COMMIT");
  return { userId, mode };
} catch (error) {
  await db.query("ROLLBACK");
  throw error;
} finally {
  await db.end();
}
