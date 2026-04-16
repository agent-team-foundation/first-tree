import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { sessionOutputs } from "../db/schema/session-outputs.js";
import { uuidv7 } from "../uuid.js";

/** Append text content to a session's output buffer. Upserts atomically via ON CONFLICT. */
export async function appendOutput(db: Database, agentId: string, chatId: string, content: string): Promise<void> {
  const now = new Date();
  await db
    .insert(sessionOutputs)
    .values({ id: uuidv7(), agentId, chatId, content, updatedAt: now })
    .onConflictDoUpdate({
      target: [sessionOutputs.agentId, sessionOutputs.chatId],
      set: {
        content: sql`${sessionOutputs.content} || ${content}`,
        updatedAt: now,
      },
    });
}

/** Get session output for a specific (agent, chat) pair. Returns null if no output. */
export async function getOutput(
  db: Database,
  agentId: string,
  chatId: string,
): Promise<{ content: string; updatedAt: string } | null> {
  const [row] = await db
    .select({ content: sessionOutputs.content, updatedAt: sessionOutputs.updatedAt })
    .from(sessionOutputs)
    .where(and(eq(sessionOutputs.agentId, agentId), eq(sessionOutputs.chatId, chatId)))
    .limit(1);

  if (!row) return null;
  return { content: row.content, updatedAt: row.updatedAt.toISOString() };
}

/** Clear session output when a session is evicted or terminated. */
export async function clearOutput(db: Database, agentId: string, chatId: string): Promise<void> {
  await db.delete(sessionOutputs).where(and(eq(sessionOutputs.agentId, agentId), eq(sessionOutputs.chatId, chatId)));
}
