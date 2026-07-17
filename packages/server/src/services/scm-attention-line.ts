import { and, asc, eq } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";

export type ScmBindingPair = {
  organizationId: string;
  humanAgentId: string;
  wakeAgentId: string;
};

export type ScmFollowLineRecord = {
  chatId: string;
};

export type ScmFollowLineStorage<TRecord extends ScmFollowLineRecord> = {
  /** Deterministic order; the first row is the canonical existing line. */
  listLines: () => Promise<TRecord[]>;
  /** Insert or provider-specific legacy upgrade, returning the surviving row. */
  createLine: () => Promise<{ record: TRecord; inserted: boolean }>;
  /** Move the canonical row. Null means it vanished in a concurrent unfollow. */
  moveLine: (record: TRecord) => Promise<TRecord | null>;
  /** Remove non-canonical rows for the same logical attention line. */
  removeLines: (records: TRecord[]) => Promise<void>;
  getChatTopic: (chatId: string) => Promise<string | null>;
};

export type ScmFollowLineResult<TRecord extends ScmFollowLineRecord> =
  | { outcome: "created" | "already_following" | "rebound"; record: TRecord }
  | { outcome: "conflict"; conflict: { chatId: string; topic: string | null } };

/**
 * Provider-neutral follow state machine.
 *
 * Provider adapters own only atomic storage callbacks. This function is the
 * single definition of pair-aware idempotency, one-line/one-room conflict,
 * explicit rebind, duplicate cleanup, and the vanished-row race fallback.
 */
export async function executeScmFollowLine<TRecord extends ScmFollowLineRecord>(input: {
  targetChatId: string;
  rebind: boolean;
  storage: ScmFollowLineStorage<TRecord>;
}): Promise<ScmFollowLineResult<TRecord>> {
  const existing = await input.storage.listLines();
  const sameChatIndex = existing.findIndex((line) => line.chatId === input.targetChatId);
  if (sameChatIndex >= 0) {
    const sameChat = existing[sameChatIndex];
    if (!sameChat) throw new Error("SCM follow line disappeared from its deterministic snapshot");
    await input.storage.removeLines(existing.filter((_, index) => index !== sameChatIndex));
    return { outcome: "already_following", record: sameChat };
  }

  const elsewhere = existing[0];
  if (elsewhere && !input.rebind) {
    return {
      outcome: "conflict",
      conflict: {
        chatId: elsewhere.chatId,
        topic: await input.storage.getChatTopic(elsewhere.chatId),
      },
    };
  }

  let rebindFallback = false;
  if (elsewhere) {
    await input.storage.removeLines(existing.slice(1));
    const moved = await input.storage.moveLine(elsewhere);
    if (moved) return { outcome: "rebound", record: moved };
    rebindFallback = true;
  }

  const created = await input.storage.createLine();
  if (created.inserted) return { outcome: "created", record: created.record };
  if (created.record.chatId === input.targetChatId) {
    return {
      outcome: rebindFallback ? "created" : "already_following",
      record: created.record,
    };
  }
  return {
    outcome: "conflict",
    conflict: {
      chatId: created.record.chatId,
      topic: await input.storage.getChatTopic(created.record.chatId),
    },
  };
}

/**
 * Resolve the durable attention owner for an agent-issued follow.
 *
 * The selected agent is always the wake side. The human side is its linked
 * active human in the chat, or the chat's sole active human when no explicit
 * delegate relationship exists. Ambiguous ownership fails closed.
 */
export async function resolveAgentScmBindingPair(
  db: Database,
  chatId: string,
  wakeAgentId: string,
): Promise<ScmBindingPair | null> {
  const rows = await db
    .select({
      chatOrganizationId: chats.organizationId,
      agentId: chatMembership.agentId,
      agentOrganizationId: agents.organizationId,
      agentType: agents.type,
      agentStatus: agents.status,
      delegateMention: agents.delegateMention,
      accessMode: chatMembership.accessMode,
    })
    .from(chatMembership)
    .innerJoin(chats, eq(chatMembership.chatId, chats.id))
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(eq(chatMembership.chatId, chatId))
    .orderBy(asc(chatMembership.agentId));

  const wakeAgent = rows.find((row) => row.agentId === wakeAgentId);
  if (
    !wakeAgent ||
    wakeAgent.agentType === "human" ||
    wakeAgent.agentStatus !== "active" ||
    wakeAgent.accessMode !== "speaker"
  ) {
    return null;
  }
  if (wakeAgent.agentOrganizationId !== wakeAgent.chatOrganizationId) return null;

  const humans = rows.filter(
    (row) =>
      row.agentType === "human" && row.agentStatus === "active" && row.agentOrganizationId === row.chatOrganizationId,
  );
  const linkedHumans = humans.filter((human) => human.delegateMention === wakeAgentId);
  const representative = linkedHumans.length === 1 ? linkedHumans[0] : linkedHumans.length === 0 ? humans[0] : null;
  if (!representative || (linkedHumans.length === 0 && humans.length !== 1)) return null;
  return {
    organizationId: representative.chatOrganizationId,
    humanAgentId: representative.agentId,
    wakeAgentId,
  };
}

/**
 * Resolve the pair for a human-issued follow. A configured delegate that is
 * not an active speaker would form a silent line, so this fails closed.
 */
export async function resolveHumanScmBindingPair(
  db: Database,
  chatId: string,
  humanAgentId: string,
): Promise<ScmBindingPair | null> {
  const [human] = await db
    .select({
      organizationId: chats.organizationId,
      agentOrganizationId: agents.organizationId,
      agentType: agents.type,
      agentStatus: agents.status,
      delegateMention: agents.delegateMention,
    })
    .from(chatMembership)
    .innerJoin(chats, eq(chatMembership.chatId, chats.id))
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, humanAgentId),
        eq(chatMembership.accessMode, "speaker"),
      ),
    )
    .limit(1);
  if (
    !human ||
    human.agentType !== "human" ||
    human.agentStatus !== "active" ||
    human.agentOrganizationId !== human.organizationId ||
    !human.delegateMention
  ) {
    return null;
  }

  const [wakeAgent] = await db
    .select({ id: agents.uuid })
    .from(chatMembership)
    .innerJoin(agents, eq(chatMembership.agentId, agents.uuid))
    .where(
      and(
        eq(chatMembership.chatId, chatId),
        eq(chatMembership.agentId, human.delegateMention),
        eq(chatMembership.accessMode, "speaker"),
        eq(agents.status, "active"),
        eq(agents.organizationId, human.organizationId),
      ),
    )
    .limit(1);
  if (!wakeAgent) return null;
  return {
    organizationId: human.organizationId,
    humanAgentId,
    wakeAgentId: wakeAgent.id,
  };
}
