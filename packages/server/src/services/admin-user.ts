import { randomUUID } from "node:crypto";
import type { CreateAdminUser, UpdateAdminUser } from "@agent-hub/shared";
import bcrypt from "bcrypt";
import { desc, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { adminUsers } from "../db/schema/admin-users.js";
import { ConflictError, NotFoundError } from "../errors.js";

const SALT_ROUNDS = 10;

function toResponse(row: typeof adminUsers.$inferSelect) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: row.createdAt,
    lastLoginAt: row.lastLoginAt,
  };
}

export async function listAdminUsers(db: Database) {
  const rows = await db.select().from(adminUsers).orderBy(desc(adminUsers.createdAt));
  return rows.map(toResponse);
}

export async function getAdminUser(db: Database, id: string) {
  const [row] = await db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
  if (!row) throw new NotFoundError(`Admin user "${id}" not found`);
  return toResponse(row);
}

export async function createAdminUser(db: Database, data: CreateAdminUser) {
  const passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
  const id = randomUUID();

  try {
    const [row] = await db
      .insert(adminUsers)
      .values({
        id,
        username: data.username,
        passwordHash,
        role: data.role ?? "admin",
      })
      .returning();
    if (!row) throw new Error("Unexpected: INSERT RETURNING produced no row");
    return toResponse(row);
  } catch (err) {
    const pgCode = (err as { code?: string })?.code ?? (err as { cause?: { code?: string } })?.cause?.code ?? "";
    if (pgCode === "23505") {
      throw new ConflictError(`Username "${data.username}" already exists`);
    }
    throw err;
  }
}

export async function updateAdminUser(db: Database, id: string, data: UpdateAdminUser) {
  const setClause: Record<string, unknown> = {};
  if (data.role !== undefined) setClause.role = data.role;
  if (data.password !== undefined) {
    setClause.passwordHash = await bcrypt.hash(data.password, SALT_ROUNDS);
  }

  if (Object.keys(setClause).length === 0) {
    return getAdminUser(db, id);
  }

  const [row] = await db.update(adminUsers).set(setClause).where(eq(adminUsers.id, id)).returning();
  if (!row) throw new NotFoundError(`Admin user "${id}" not found`);
  return toResponse(row);
}

export async function deleteAdminUser(db: Database, id: string) {
  const [row] = await db.delete(adminUsers).where(eq(adminUsers.id, id)).returning();
  if (!row) throw new NotFoundError(`Admin user "${id}" not found`);
}
