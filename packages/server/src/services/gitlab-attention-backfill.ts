import { and, asc, eq, isNotNull, isNull, or } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { gitlabConnections } from "../db/schema/gitlab-connections.js";
import { gitlabEntityChatMappings } from "../db/schema/gitlab-entity-chat-mappings.js";
import { withGitlabConnectionMaintenanceFence } from "./gitlab-connections.js";

const ATTENTION_BACKFILL_VERSION = 1;

export type GitlabAttentionBackfillResult = {
  paired: number;
  legacyRouteOnly: number;
};

/**
 * Classify every historical explicit row exactly once.
 *
 * The schema default is deliberately `legacy_route_only`/version 0 so an old
 * replica that writes after the migration can never accidentally create a
 * wake line. Under the same connection-row fence used by follow and ingress,
 * this pass upgrades only a uniquely derivable pair and permanently stamps
 * every ambiguous row as version 1.
 */
export async function backfillGitlabAttentionPairs(db: Database): Promise<GitlabAttentionBackfillResult> {
  const result: GitlabAttentionBackfillResult = { paired: 0, legacyRouteOnly: 0 };
  const connections = await db
    .select({ id: gitlabConnections.id })
    .from(gitlabConnections)
    .orderBy(asc(gitlabConnections.id));

  for (const connection of connections) {
    const connectionResult = await withGitlabConnectionMaintenanceFence(db, connection.id, classifyConnectionRows);
    if (!connectionResult) continue;
    result.paired += connectionResult.paired;
    result.legacyRouteOnly += connectionResult.legacyRouteOnly;
  }
  return result;
}

async function classifyConnectionRows(
  tx: Database,
  connection: typeof gitlabConnections.$inferSelect,
): Promise<GitlabAttentionBackfillResult> {
  const result: GitlabAttentionBackfillResult = { paired: 0, legacyRouteOnly: 0 };

  // Rows already carrying a complete pair predate the classification column
  // but are not ambiguous. Stamp them without changing ownership.
  await tx
    .update(gitlabEntityChatMappings)
    .set({
      attentionMode: "paired",
      attentionBackfillVersion: ATTENTION_BACKFILL_VERSION,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gitlabEntityChatMappings.connectionId, connection.id),
        eq(gitlabEntityChatMappings.attentionBackfillVersion, 0),
        isNotNull(gitlabEntityChatMappings.humanAgentId),
        isNotNull(gitlabEntityChatMappings.delegateAgentId),
      ),
    );

  const legacyRows = await tx
    .select()
    .from(gitlabEntityChatMappings)
    .where(
      and(
        eq(gitlabEntityChatMappings.connectionId, connection.id),
        eq(gitlabEntityChatMappings.attentionBackfillVersion, 0),
        isNull(gitlabEntityChatMappings.humanAgentId),
        isNull(gitlabEntityChatMappings.delegateAgentId),
        or(
          eq(gitlabEntityChatMappings.boundVia, "agent_declared"),
          eq(gitlabEntityChatMappings.boundVia, "human_declared"),
        ),
      ),
    )
    .orderBy(
      asc(gitlabEntityChatMappings.projectPathNormalized),
      asc(gitlabEntityChatMappings.entityType),
      asc(gitlabEntityChatMappings.entityIid),
      asc(gitlabEntityChatMappings.chatId),
      asc(gitlabEntityChatMappings.id),
    );

  const resolved = await Promise.all(
    legacyRows.map(async (row) => ({
      row,
      pair: await resolveLegacyPair(tx, row),
    })),
  );
  const groups = new Map<string, typeof resolved>();
  for (const candidate of resolved) {
    if (!candidate.pair) continue;
    const key = [entityIdentityKey(candidate.row), candidate.pair.humanAgentId, candidate.pair.delegateAgentId].join(
      ":",
    );
    const group = groups.get(key);
    if (group) group.push(candidate);
    else groups.set(key, [candidate]);
  }

  for (const candidate of resolved) {
    const pair = candidate.pair;
    const group = pair
      ? groups.get([entityIdentityKey(candidate.row), pair.humanAgentId, pair.delegateAgentId].join(":"))
      : undefined;
    const uniqueAcrossChats = group?.length === 1;
    const conflict = pair ? await hasPairConflict(tx, candidate.row, pair) : true;
    const canPair = Boolean(pair && uniqueAcrossChats && !conflict);
    const [updated] = await tx
      .update(gitlabEntityChatMappings)
      .set({
        ...(canPair && pair
          ? {
              humanAgentId: pair.humanAgentId,
              delegateAgentId: pair.delegateAgentId,
              attentionMode: "paired",
            }
          : { attentionMode: "legacy_route_only" }),
        attentionBackfillVersion: ATTENTION_BACKFILL_VERSION,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gitlabEntityChatMappings.id, candidate.row.id),
          eq(gitlabEntityChatMappings.attentionBackfillVersion, 0),
          isNull(gitlabEntityChatMappings.humanAgentId),
          isNull(gitlabEntityChatMappings.delegateAgentId),
        ),
      )
      .returning({ id: gitlabEntityChatMappings.id });
    if (!updated) continue;
    if (canPair) result.paired++;
    else result.legacyRouteOnly++;
  }
  return result;
}

type LegacyRow = typeof gitlabEntityChatMappings.$inferSelect;
type Pair = { humanAgentId: string; delegateAgentId: string };

function entityIdentityKey(row: LegacyRow): string {
  return row.projectId === null
    ? `pending:${row.projectPathNormalized}:${row.entityType}:${row.entityIid}`
    : `observed:${row.projectId}:${row.entityType}:${row.entityIid}`;
}

async function resolveLegacyPair(db: Database, row: LegacyRow): Promise<Pair | null> {
  const speakers = await db
    .select({
      agentId: agents.uuid,
      type: agents.type,
      status: agents.status,
      delegateMention: agents.delegateMention,
    })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(and(eq(chatMembership.chatId, row.chatId), eq(chatMembership.accessMode, "speaker")));
  const active = speakers.filter((speaker) => speaker.status === "active");

  if (row.boundVia === "agent_declared") {
    const declarer = active.find((speaker) => speaker.agentId === row.declaredByAgentId);
    if (!declarer || declarer.type === "human") return null;
    const linkedHumans = active.filter(
      (speaker) => speaker.type === "human" && speaker.delegateMention === declarer.agentId,
    );
    if (linkedHumans.length === 1 && linkedHumans[0]) {
      return { humanAgentId: linkedHumans[0].agentId, delegateAgentId: declarer.agentId };
    }
    if (linkedHumans.length > 1) return null;
    const humans = active.filter((speaker) => speaker.type === "human");
    return humans.length === 1 && humans[0]
      ? { humanAgentId: humans[0].agentId, delegateAgentId: declarer.agentId }
      : null;
  }

  const declarer = active.find((speaker) => speaker.agentId === row.declaredByAgentId && speaker.type === "human");
  if (!declarer?.delegateMention) return null;
  const delegates = active.filter(
    (speaker) => speaker.agentId === declarer.delegateMention && speaker.type !== "human",
  );
  return delegates.length === 1 && delegates[0]
    ? { humanAgentId: declarer.agentId, delegateAgentId: delegates[0].agentId }
    : null;
}

async function hasPairConflict(db: Database, row: LegacyRow, pair: Pair): Promise<boolean> {
  const [existing] = await db
    .select({ id: gitlabEntityChatMappings.id })
    .from(gitlabEntityChatMappings)
    .where(
      and(
        eq(gitlabEntityChatMappings.connectionId, row.connectionId),
        eq(gitlabEntityChatMappings.entityType, row.entityType),
        eq(gitlabEntityChatMappings.entityIid, row.entityIid),
        row.projectId === null
          ? and(
              isNull(gitlabEntityChatMappings.projectId),
              eq(gitlabEntityChatMappings.projectPathNormalized, row.projectPathNormalized),
            )
          : eq(gitlabEntityChatMappings.projectId, row.projectId),
        eq(gitlabEntityChatMappings.humanAgentId, pair.humanAgentId),
        eq(gitlabEntityChatMappings.delegateAgentId, pair.delegateAgentId),
        eq(gitlabEntityChatMappings.active, true),
      ),
    )
    .limit(1);
  return existing !== undefined;
}
