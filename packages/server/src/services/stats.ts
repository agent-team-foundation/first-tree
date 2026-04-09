import { and, count, eq, ne } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chats } from "../db/schema/chats.js";
import { messages } from "../db/schema/messages.js";

type OrgBreakdown = { organizationId: string; agentCount: number; chatCount: number; messageCount: number };

export async function getStats(db: Database, orgId?: string) {
  const agentsByOrg = await db
    .select({ organizationId: agents.organizationId, agentCount: count() })
    .from(agents)
    .where(orgId ? and(ne(agents.status, "deleted"), eq(agents.organizationId, orgId)) : ne(agents.status, "deleted"))
    .groupBy(agents.organizationId);

  const chatsByOrg = await db
    .select({ organizationId: chats.organizationId, chatCount: count() })
    .from(chats)
    .where(orgId ? eq(chats.organizationId, orgId) : undefined)
    .groupBy(chats.organizationId);

  const msgsByOrg = await db
    .select({ organizationId: chats.organizationId, messageCount: count() })
    .from(messages)
    .innerJoin(chats, eq(messages.chatId, chats.id))
    .where(orgId ? eq(chats.organizationId, orgId) : undefined)
    .groupBy(chats.organizationId);

  // Merge into a single breakdown
  const orgMap = new Map<string, OrgBreakdown>();
  for (const r of agentsByOrg) {
    orgMap.set(r.organizationId, {
      organizationId: r.organizationId,
      agentCount: r.agentCount,
      chatCount: 0,
      messageCount: 0,
    });
  }
  for (const r of chatsByOrg) {
    const entry = orgMap.get(r.organizationId) ?? {
      organizationId: r.organizationId,
      agentCount: 0,
      chatCount: 0,
      messageCount: 0,
    };
    entry.chatCount = r.chatCount;
    orgMap.set(r.organizationId, entry);
  }
  for (const r of msgsByOrg) {
    const entry = orgMap.get(r.organizationId) ?? {
      organizationId: r.organizationId,
      agentCount: 0,
      chatCount: 0,
      messageCount: 0,
    };
    entry.messageCount = r.messageCount;
    orgMap.set(r.organizationId, entry);
  }

  const byOrganization = [...orgMap.values()];

  // Derive totals from breakdown (no extra queries)
  let totalAgents = 0;
  let totalChats = 0;
  let totalMessages = 0;
  for (const o of byOrganization) {
    totalAgents += o.agentCount;
    totalChats += o.chatCount;
    totalMessages += o.messageCount;
  }

  return { totalAgents, totalChats, totalMessages, byOrganization };
}
