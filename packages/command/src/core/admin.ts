import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * Check if any admin user exists.
 */
export async function hasAdminUser(databaseUrl: string): Promise<boolean> {
  const client = postgres(databaseUrl, { max: 1 });
  try {
    const result = await client`SELECT count(*)::int AS count FROM admin_users`;
    return (result[0] as { count: number }).count > 0;
  } finally {
    await client.end();
  }
}

/**
 * Create an admin user. Returns the generated password.
 */
export async function createAdminUser(
  databaseUrl: string,
  username: string,
  password?: string,
): Promise<{ username: string; password: string }> {
  const pw = password ?? randomBytes(12).toString("base64url");
  const hash = await bcrypt.hash(pw, 12);

  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client);

  try {
    await db.execute(sql`
      INSERT INTO admin_users (id, username, password_hash, role)
      VALUES (${randomUUID()}, ${username}, ${hash}, 'super_admin')
    `);
  } finally {
    await client.end();
  }

  return { username, password: pw };
}
