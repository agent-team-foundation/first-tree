// One-shot ops script for NHA M0 cleanup.
//
// Background:
//   M0 removed the chat-internal AskUserQuestion bridge and the
//   `format=question` write path (see first-tree #578). Going forward no
//   new `pending_questions` rows can be created. But any rows already in
//   `status='pending'` from before the cutover have no producer left to
//   resolve them: SessionManager no longer tracks the bridge entries, and
//   the answer route has been removed. Those rows would keep their chats
//   pinned in the chat-list "needs-you" attention bucket until each chat
//   was independently archived or its client was re-claimed.
//
//   This script marks every still-pending row as `superseded` with reason
//   `nha_m0_cleanup`, so the historical signal clears in one pass. It is
//   safe to re-run (already-superseded rows are a no-op).
//
// Usage (from packages/server):
//   DATABASE_URL=postgresql://… npx tsx scripts/m0-supersede-historical-pending-questions.mjs
//
// The script prints how many rows were touched and the distinct chat ids
// affected (in case the operator wants to fire a UI refresh for them).

import { eq } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const { drizzle } = await import("drizzle-orm/postgres-js");
const postgres = (await import("postgres")).default;
const { pendingQuestions } = await import("../src/db/schema/pending-questions.ts");

const client = postgres(DB_URL, { max: 1 });
const db = drizzle(client);

try {
  const rows = await db
    .update(pendingQuestions)
    .set({
      status: "superseded",
      supersededAt: new Date(),
      supersededReason: "nha_m0_cleanup",
    })
    .where(eq(pendingQuestions.status, "pending"))
    .returning({ id: pendingQuestions.id, chatId: pendingQuestions.chatId });

  const chatIds = [...new Set(rows.map((r) => r.chatId))];
  console.log(`Superseded ${rows.length} pending_questions row(s) across ${chatIds.length} chat(s).`);
  if (chatIds.length > 0) {
    console.log("Affected chat ids:");
    for (const id of chatIds) console.log(`  ${id}`);
  }
} finally {
  await client.end();
}
