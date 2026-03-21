import { SYSTEM_CONFIG_DEFAULTS } from "@agent-hub/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { systemConfigs } from "../db/schema/system-configs.js";

export async function getAllConfigs(db: Database): Promise<Record<string, unknown>> {
  const rows = await db.select().from(systemConfigs);
  const result: Record<string, unknown> = { ...SYSTEM_CONFIG_DEFAULTS };
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export async function getConfig(db: Database, key: string): Promise<unknown> {
  const [row] = await db.select().from(systemConfigs).where(eq(systemConfigs.key, key)).limit(1);
  if (row) return row.value;
  return (SYSTEM_CONFIG_DEFAULTS as Record<string, unknown>)[key] ?? null;
}

export async function updateConfigs(db: Database, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
  const now = new Date();
  for (const [key, value] of Object.entries(updates)) {
    await db
      .insert(systemConfigs)
      .values({ key, value, updatedAt: now })
      .onConflictDoUpdate({
        target: systemConfigs.key,
        set: { value, updatedAt: now },
      });
  }
  return getAllConfigs(db);
}
