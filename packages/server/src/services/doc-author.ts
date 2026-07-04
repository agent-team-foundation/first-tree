import type { DocAuthor } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { UnauthorizedError } from "../errors.js";

/**
 * Host-identity adapter for the document review (docloop) domain.
 *
 * This is deliberately the ONLY place the doc feature reads a hub identity
 * table: it turns an agents-table uuid — the acting agent on Class D routes,
 * or a member's human identity-mirror agent on Class B/C routes — into the
 * `DocAuthor` principal the domain service consumes. `kind` comes from
 * `agents.type`, so a human driving the CLI through their mirror agent is
 * still recorded as a human author. Extracting docloop into a standalone
 * product means replacing this file, nothing in `services/document.ts`.
 */
export async function docAuthorForAgentUuid(db: Database, agentUuid: string): Promise<DocAuthor> {
  const [row] = await db
    .select({ name: agents.name, type: agents.type })
    .from(agents)
    .where(eq(agents.uuid, agentUuid))
    .limit(1);
  if (!row) {
    throw new UnauthorizedError("Caller identity not found");
  }
  return { kind: row.type === "human" ? "human" : "agent", id: agentUuid, name: row.name ?? "unknown" };
}
