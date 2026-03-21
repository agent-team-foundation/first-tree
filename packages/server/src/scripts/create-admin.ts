import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { adminUsers } from "../db/schema/admin-users.js";

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error("Usage: tsx src/scripts/create-admin.ts <username> <password>");
    process.exit(1);
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  const client = postgres(url);
  const db = drizzle(client);

  const hash = await bcrypt.hash(password, 12);

  await db.insert(adminUsers).values({
    id: randomUUID(),
    username,
    passwordHash: hash,
    role: "super_admin",
  });

  console.log(`Admin user "${username}" created successfully.`);
  await client.end();
}

main().catch((err) => {
  console.error("Failed to create admin:", err);
  process.exit(1);
});
