import { createHash } from "node:crypto";
import {
  AGENT_STATUSES,
  type CreateChatWithInitialMessage,
  type CreateChatWithInitialMessageResult,
  type CreateMeChatWithInitialMessage,
  type CreateMeChatWithInitialMessageResult,
  MESSAGE_SOURCES,
  type SendMessage,
} from "@first-tree/shared";
import { and, eq, ne, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { AppError, BadRequestError, NotFoundError, StructuredAppError } from "../errors.js";
import {
  type CreateChatTargetContext,
  insertChatWithParticipants,
  validateCreateChatParticipantBaseGate,
} from "./chat.js";
import { type SendMessageOptions, sendMessage } from "./message.js";

// biome-ignore lint/suspicious/noExplicitAny: Drizzle transaction clients do not expose a concrete schema type here.
type DbLike = PgDatabase<PgQueryResultHKT, any, any>;

type ResolvedCreateTarget = {
  agentId: string;
  option: "--to" | "--with";
  input: string;
  status: string;
};

type CreateChatWithInitialMessageServiceResult = CreateChatWithInitialMessageResult & {
  recipients: string[];
};

type CreateChatWithInitialMessageOptions = {
  beforeCreate?: () => void | Promise<void>;
};

type PreparedInitialMessage = {
  chat: { id: string };
  senderAgentId: string;
  recipientAgentIds: string[];
  participantAgentIds: string[];
  messageData: SendMessage;
  operationId?: string;
};

type InitialMessageFailureContext = {
  operationId?: string;
  chatId: string;
};

type InitialMessageParticipant = {
  id: string;
  status: string;
};

const CHAT_CREATE_PROCESS_DEDUPE_TTL_MS = 15 * 60 * 1000;

type ChatCreateProcessDedupeEntry = {
  requestHash: string;
  promise: Promise<CreateChatWithInitialMessageServiceResult>;
  expiresAt?: number;
};

const chatCreateProcessDedupe = new Map<string, ChatCreateProcessDedupeEntry>();

function chatCreateStructuredError(
  statusCode: number,
  publicCode: string,
  message: string,
  details: Record<string, unknown>,
): StructuredAppError {
  return new StructuredAppError(statusCode, publicCode, message, details);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJson(entryValue)}`).join(",")}}`;
}

function createChatRequestHash(input: CreateChatWithInitialMessage): string {
  const payload = {
    to: input.to,
    with: input.with,
    message: {
      format: input.message.format,
      content: input.message.content,
      source: input.message.source ?? MESSAGE_SOURCES.API,
      metadata: input.message.metadata,
    },
    topic: input.topic,
    metadata: input.metadata,
  };
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

function chatCreateProcessDedupeKey(senderAgentId: string, operationId: string): string {
  return `${senderAgentId}\0${operationId}`;
}

function pruneExpiredChatCreateProcessDedupe(now = Date.now()): void {
  for (const [key, entry] of chatCreateProcessDedupe) {
    if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
      chatCreateProcessDedupe.delete(key);
    }
  }
}

function assertChatCreateProcessDedupeRequestMatches(
  operationId: string,
  existingRequestHash: string,
  requestHash: string,
): void {
  if (existingRequestHash === requestHash) return;
  throw chatCreateStructuredError(
    409,
    "CHAT_CREATE_IDEMPOTENCY_KEY_REUSED",
    "This operationId was already used with a different chat create request in this server process.",
    {
      operationId,
      hint: "Use the original request body with this operationId, or retry the new request with a fresh operationId.",
    },
  );
}

function replayChatCreateProcessDedupeResult(
  result: CreateChatWithInitialMessageServiceResult,
): CreateChatWithInitialMessageServiceResult {
  return {
    ...result,
    replayed: true,
    recipients: [],
  };
}

export function clearChatCreateProcessDedupeForTests(): void {
  chatCreateProcessDedupe.clear();
}

function selectorParts(input: string): { kind: "id" | "name" | "raw"; value: string } {
  if (input.startsWith("id:")) return { kind: "id", value: input.slice("id:".length) };
  if (input.startsWith("name:")) return { kind: "name", value: input.slice("name:".length) };
  return { kind: "raw", value: input };
}

function createTargetErrorDetails(option: "--to" | "--with", input: string, hint: string): Record<string, unknown> {
  return { option, input, hint };
}

async function resolveCreateChatTarget(
  tx: DbLike,
  orgId: string,
  option: "--to" | "--with",
  input: string,
): Promise<ResolvedCreateTarget> {
  const selector = selectorParts(input);
  const base = and(eq(agents.organizationId, orgId), ne(agents.status, AGENT_STATUSES.DELETED));
  const where =
    selector.kind === "id"
      ? and(base, eq(agents.uuid, selector.value))
      : selector.kind === "name"
        ? and(base, eq(agents.name, selector.value))
        : and(base, or(eq(agents.uuid, selector.value), eq(agents.name, selector.value)));
  const rows = await tx.select({ uuid: agents.uuid, status: agents.status }).from(agents).where(where).limit(2);

  if (rows.length === 0) {
    throw chatCreateStructuredError(
      400,
      "CHAT_CREATE_TARGET_NOT_FOUND",
      `Agent "${input}" was not found.`,
      createTargetErrorDetails(
        option,
        input,
        "Use an active agent name, id:<uuid>, or name:<agent-name> from the sender's organization.",
      ),
    );
  }
  if (rows.length > 1) {
    throw chatCreateStructuredError(
      400,
      "CHAT_CREATE_SELECTOR_AMBIGUOUS",
      `Agent selector "${input}" matches more than one target.`,
      createTargetErrorDetails(option, input, "Retry with id:<uuid> or name:<agent-name>."),
    );
  }
  const row = rows[0];
  if (!row) throw new Error("Unexpected: target query returned no row");
  return { agentId: row.uuid, option, input, status: row.status };
}

function assertNoDuplicateInputs(inputs: ReadonlyArray<string>, option: "--to" | "--with"): void {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input)) {
      throw chatCreateStructuredError(
        400,
        "CHAT_CREATE_DUPLICATE_TARGET",
        `Duplicate target "${input}" passed to ${option}.`,
        createTargetErrorDetails(option, input, "Remove duplicate --to/--with values and retry."),
      );
    }
    seen.add(input);
  }
}

function validateResolvedCreateTargets(senderId: string, targets: ReadonlyArray<ResolvedCreateTarget>): void {
  const byAgentId = new Map<string, ResolvedCreateTarget>();
  for (const target of targets) {
    if (target.agentId === senderId) {
      throw chatCreateStructuredError(
        400,
        "CHAT_CREATE_SELF_TARGET",
        "The sender is automatically added to the new chat and cannot be listed as a target.",
        createTargetErrorDetails(target.option, target.input, "Remove the sender from --to/--with and retry."),
      );
    }
    if (target.status !== AGENT_STATUSES.ACTIVE) {
      throw chatCreateStructuredError(
        400,
        "CHAT_CREATE_TARGET_INACTIVE",
        `Agent "${target.input}" is ${target.status} and cannot be added to a new task chat.`,
        createTargetErrorDetails(target.option, target.input, "Reactivate the agent or choose another active target."),
      );
    }
    const existing = byAgentId.get(target.agentId);
    if (existing) {
      throw chatCreateStructuredError(
        400,
        "CHAT_CREATE_DUPLICATE_TARGET",
        `Agent "${target.input}" is listed more than once.`,
        {
          targets: [
            { option: existing.option, input: existing.input },
            { option: target.option, input: target.input },
          ],
          hint: "A target may appear in --to or --with, but not both and not more than once.",
        },
      );
    }
    byAgentId.set(target.agentId, target);
  }
}

function validateMeInitialMessageRecipients(
  senderAgentId: string,
  participantIds: ReadonlyArray<string>,
  participants: ReadonlyArray<InitialMessageParticipant>,
  mentions: ReadonlyArray<string> | undefined,
): void {
  const participantSet = new Set([senderAgentId, ...participantIds]);
  const participantsById = new Map(participants.map((participant) => [participant.id, participant]));
  const recipientIds = [...new Set(mentions ?? [])].filter((id) => id !== senderAgentId);

  if (recipientIds.length === 0) {
    throw new BadRequestError("Starting a chat requires at least one non-self message recipient mention.");
  }

  for (const recipientId of recipientIds) {
    if (!participantSet.has(recipientId)) {
      throw new BadRequestError(`Initial message recipient "${recipientId}" must be a participant of the new chat.`);
    }

    const participant = participantsById.get(recipientId);
    if (!participant || participant.status !== AGENT_STATUSES.ACTIVE) {
      const status = participant?.status ?? "missing";
      const recovery =
        status === AGENT_STATUSES.SUSPENDED
          ? "Reactivate it before starting the chat."
          : "Choose an active recipient before starting the chat.";
      throw new BadRequestError(`Cannot route to "${recipientId}" because the agent is ${status}. ${recovery}`);
    }
  }
}

async function sendPreparedInitialMessage(
  db: Database,
  prepared: PreparedInitialMessage,
  failureContext: InitialMessageFailureContext,
  options: SendMessageOptions = {},
) {
  try {
    return await sendMessage(db, prepared.chat.id, prepared.senderAgentId, prepared.messageData, options);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    const statusCode =
      error instanceof AppError && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    throw chatCreateStructuredError(
      statusCode,
      "CHAT_CREATE_INITIAL_MESSAGE_FAILED",
      "Chat was created, but the initial message could not be sent.",
      {
        ...(failureContext.operationId ? { operationId: failureContext.operationId } : {}),
        chatId: failureContext.chatId,
        cause,
        hint: "The new chat may be empty. Inspect the chatId, then retry with a corrected message or send the first message into that chat.",
      },
    );
  }
}

async function createAgentChatWithInitialMessageOnce(
  db: Database,
  senderAgentId: string,
  input: CreateChatWithInitialMessage,
): Promise<CreateChatWithInitialMessageServiceResult> {
  const prepared = await db.transaction(async (tx) => {
    if (input.to.length === 0) {
      throw chatCreateStructuredError(
        400,
        "CHAT_CREATE_MISSING_TO",
        "`chat create` requires at least one --to target.",
        {
          option: "--to",
          hint: "Pass --to <agent-name-or-id> for each first-message recipient.",
        },
      );
    }
    if (input.message.content.trim().length === 0) {
      throw chatCreateStructuredError(400, "CHAT_CREATE_EMPTY_MESSAGE", "`chat create` requires a non-empty message.", {
        option: "--message",
        input: input.message.content,
        hint: "Pass --message <text> or pipe non-empty stdin.",
      });
    }
    assertNoDuplicateInputs(input.to, "--to");
    assertNoDuplicateInputs(input.with, "--with");

    const [sender] = await tx
      .select({ organizationId: agents.organizationId })
      .from(agents)
      .where(eq(agents.uuid, senderAgentId))
      .limit(1);
    if (!sender) throw new NotFoundError(`Sender agent "${senderAgentId}" not found`);

    const toTargets: ResolvedCreateTarget[] = [];
    for (const target of input.to) {
      toTargets.push(await resolveCreateChatTarget(tx, sender.organizationId, "--to", target));
    }
    const withTargets: ResolvedCreateTarget[] = [];
    for (const target of input.with) {
      withTargets.push(await resolveCreateChatTarget(tx, sender.organizationId, "--with", target));
    }
    const allTargets = [...toTargets, ...withTargets];
    validateResolvedCreateTargets(senderAgentId, allTargets);

    const contextByAgentId = new Map<string, CreateChatTargetContext>();
    for (const target of allTargets) {
      contextByAgentId.set(target.agentId, { option: target.option, input: target.input });
    }
    const participantAgentIds = [...new Set([senderAgentId, ...allTargets.map((target) => target.agentId)])];
    await validateCreateChatParticipantBaseGate(tx, senderAgentId, participantAgentIds, { contextByAgentId });

    const chat = await insertChatWithParticipants(tx, senderAgentId, sender.organizationId, participantAgentIds, {
      type: "group",
      topic: input.topic,
      metadata: input.metadata,
    });
    const recipientAgentIds = toTargets.map((target) => target.agentId);
    const messageData: SendMessage = {
      format: input.message.format,
      content: input.message.content,
      metadata: { ...(input.message.metadata ?? {}), mentions: recipientAgentIds },
      source: input.message.source ?? MESSAGE_SOURCES.API,
    };

    return {
      chat: { id: chat.id },
      operationId: input.operationId,
      senderAgentId,
      recipientAgentIds,
      participantAgentIds: chat.participants.map((participant) => participant.agentId),
      messageData,
    };
  });

  const sent = await sendPreparedInitialMessage(
    db,
    prepared,
    { operationId: prepared.operationId, chatId: prepared.chat.id },
    { normalizeMentionsInContent: true },
  );
  return {
    chat: prepared.chat,
    message: { id: sent.message.id },
    operationId: prepared.operationId ?? input.operationId,
    replayed: false,
    senderAgentId: prepared.senderAgentId,
    recipientAgentIds: prepared.recipientAgentIds,
    participantAgentIds: prepared.participantAgentIds,
    recipients: sent.recipients,
  };
}

export async function createChatWithInitialMessage(
  db: Database,
  senderAgentId: string,
  input: CreateChatWithInitialMessage,
  options: CreateChatWithInitialMessageOptions = {},
): Promise<CreateChatWithInitialMessageServiceResult> {
  pruneExpiredChatCreateProcessDedupe();
  const requestHash = createChatRequestHash(input);
  const key = chatCreateProcessDedupeKey(senderAgentId, input.operationId);
  const existing = chatCreateProcessDedupe.get(key);
  if (existing) {
    assertChatCreateProcessDedupeRequestMatches(input.operationId, existing.requestHash, requestHash);
    return replayChatCreateProcessDedupeResult(await existing.promise);
  }

  const entry: ChatCreateProcessDedupeEntry = {
    requestHash,
    promise: Promise.resolve().then(async () => {
      await options.beforeCreate?.();
      return createAgentChatWithInitialMessageOnce(db, senderAgentId, input);
    }),
  };
  chatCreateProcessDedupe.set(key, entry);
  entry.promise = entry.promise.then(
    (result) => {
      entry.expiresAt = Date.now() + CHAT_CREATE_PROCESS_DEDUPE_TTL_MS;
      return result;
    },
    (error: unknown) => {
      if (chatCreateProcessDedupe.get(key) === entry) {
        chatCreateProcessDedupe.delete(key);
      }
      throw error;
    },
  );
  return entry.promise;
}

export async function createMeChatWithInitialMessage(
  db: Database,
  humanAgentId: string,
  organizationId: string,
  input: CreateMeChatWithInitialMessage,
): Promise<CreateMeChatWithInitialMessageResult & { recipients: string[] }> {
  const prepared = await db.transaction(async (tx) => {
    const distinctIds = [...new Set(input.participantIds)].filter((id) => id !== humanAgentId);
    if (distinctIds.length === 0) {
      throw new BadRequestError("At least one non-self participant required");
    }

    const gate = await validateCreateChatParticipantBaseGate(tx, humanAgentId, distinctIds);
    if (gate.orgId !== organizationId) {
      throw new BadRequestError("Cross-organization chat not allowed");
    }
    validateMeInitialMessageRecipients(humanAgentId, distinctIds, gate.rows, input.message.metadata?.mentions);

    const chat = await insertChatWithParticipants(tx, humanAgentId, organizationId, distinctIds, {
      type: "group",
      topic: input.topic ?? undefined,
    });
    const messageData: SendMessage = {
      format: input.message.format,
      content: input.message.content,
      ...(input.message.metadata ? { metadata: input.message.metadata } : {}),
      source: MESSAGE_SOURCES.WEB,
    };

    return {
      chat: { id: chat.id },
      senderAgentId: humanAgentId,
      recipientAgentIds: input.message.metadata?.mentions ?? [],
      participantAgentIds: chat.participants.map((participant) => participant.agentId),
      messageData,
    };
  });

  const sent = await sendPreparedInitialMessage(db, prepared, { chatId: prepared.chat.id });
  return {
    chatId: prepared.chat.id,
    messageId: sent.message.id,
    recipients: sent.recipients,
  };
}
