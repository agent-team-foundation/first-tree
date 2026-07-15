import { randomUUID } from "node:crypto";
import {
  landingCampaignSlugSchema,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "@first-tree/shared";
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agents, chatMembership, chats, members, messages } from "../../db/schema/index.js";
import { NotFoundError } from "../../errors.js";
import { requireUser } from "../../scope/require-user.js";

const scanCampaignExportRequestSchema = z
  .object({
    clientId: z.string().min(1),
    agentName: z.string().min(1).default("production-scanner"),
    campaign: landingCampaignSlugSchema.default("production-scan"),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    includeMessages: z.boolean().default(true),
    redaction: z.enum(["standard", "metadata_only"]).default("standard"),
  })
  .refine((body) => !body.from || !body.to || body.from <= body.to, {
    message: "`from` must be before or equal to `to`",
    path: ["from"],
  });

type ScanCampaignExportRequest = z.infer<typeof scanCampaignExportRequestSchema>;

type ExportFileName = "manifest.json" | "trials.ndjson" | "summaries.ndjson" | "messages.ndjson";

type ExportRecord = {
  exportId: string;
  createdByUserId: string;
  createdAt: string;
  status: "completed";
  manifest: Record<string, unknown>;
  files: Partial<Record<ExportFileName, string>>;
};

const MAX_STORED_EXPORTS = 50;
const exportStore = new Map<string, ExportRecord>();

export async function scanCampaignExportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const { userId } = requireUser(request);
    const body = scanCampaignExportRequestSchema.parse(request.body);
    const record = await buildScanCampaignExport(app, userId, body);
    rememberExport(record);
    return reply.status(201).send(serializeExport(record, false));
  });

  app.get<{ Params: { exportId: string } }>("/:exportId", async (request) => {
    const { userId } = requireUser(request);
    const record = requireOwnedExport(request.params.exportId, userId);
    return serializeExport(record, false);
  });

  app.get<{ Params: { exportId: string } }>("/:exportId/download", async (request) => {
    const { userId } = requireUser(request);
    const record = requireOwnedExport(request.params.exportId, userId);
    return serializeExport(record, true);
  });
}

function requireOwnedExport(exportId: string, userId: string): ExportRecord {
  const record = exportStore.get(exportId);
  if (!record || record.createdByUserId !== userId) {
    throw new NotFoundError("Scan campaign export not found");
  }
  return record;
}

function rememberExport(record: ExportRecord): void {
  exportStore.set(record.exportId, record);
  while (exportStore.size > MAX_STORED_EXPORTS) {
    const oldest = exportStore.keys().next().value;
    if (!oldest) return;
    exportStore.delete(oldest);
  }
}

function serializeExport(record: ExportRecord, includeFiles: boolean) {
  return {
    exportId: record.exportId,
    status: record.status,
    createdAt: record.createdAt,
    manifest: record.manifest,
    ...(includeFiles ? { files: record.files } : {}),
  };
}

async function buildScanCampaignExport(
  app: FastifyInstance,
  userId: string,
  input: ScanCampaignExportRequest,
): Promise<ExportRecord> {
  const exportId = randomUUID();
  const createdAt = new Date().toISOString();

  const candidateAgents = await app.db
    .select({
      uuid: agents.uuid,
      name: agents.name,
      displayName: agents.displayName,
      organizationId: agents.organizationId,
      status: agents.status,
      metadata: agents.metadata,
      clientId: agents.clientId,
      runtimeProvider: agents.runtimeProvider,
      createdAt: agents.createdAt,
      updatedAt: agents.updatedAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.clientId, input.clientId),
        eq(agents.name, input.agentName),
        ne(agents.status, "deleted"),
        sql`${agents.metadata}->>'landingCampaignTrial' = 'true'`,
        sql`${agents.metadata}->>'campaign' = ${input.campaign}`,
      ),
    )
    .orderBy(asc(agents.createdAt), asc(agents.uuid));

  const orgIds = [...new Set(candidateAgents.map((agent) => agent.organizationId))];
  const adminOrgIds =
    orgIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await app.db
              .select({ organizationId: members.organizationId })
              .from(members)
              .where(
                and(
                  eq(members.userId, userId),
                  eq(members.role, "admin"),
                  eq(members.status, "active"),
                  inArray(members.organizationId, orgIds),
                ),
              )
          ).map((member) => member.organizationId),
        );

  const visibleAgents = candidateAgents.filter((agent) => adminOrgIds.has(agent.organizationId));
  const visibleAgentIds = visibleAgents.map((agent) => agent.uuid);
  const agentById = new Map(visibleAgents.map((agent) => [agent.uuid, agent]));
  const agentIds = new Set(visibleAgentIds);

  const chatRows =
    visibleAgentIds.length === 0
      ? []
      : await app.db
          .select({
            chatId: chats.id,
            organizationId: chats.organizationId,
            topic: chats.topic,
            description: chats.description,
            metadata: chats.metadata,
            lastMessageAt: chats.lastMessageAt,
            createdAt: chats.createdAt,
            trialAgentId: chatMembership.agentId,
          })
          .from(chatMembership)
          .innerJoin(chats, eq(chatMembership.chatId, chats.id))
          .where(
            and(
              inArray(chatMembership.agentId, visibleAgentIds),
              sql`${chats.metadata}->'landingCampaignTrial'->>'campaign' = ${input.campaign}`,
              input.from ? gte(chats.createdAt, input.from) : undefined,
              input.to ? lte(chats.createdAt, input.to) : undefined,
            ),
          )
          .orderBy(asc(chats.createdAt), asc(chats.id));

  const chatById = new Map<string, (typeof chatRows)[number]>();
  for (const row of chatRows) {
    if (!chatById.has(row.chatId)) chatById.set(row.chatId, row);
  }
  const visibleChats = [...chatById.values()];
  const chatIds = visibleChats.map((chat) => chat.chatId);

  const messageRows =
    input.includeMessages && chatIds.length > 0
      ? await app.db
          .select({
            id: messages.id,
            chatId: messages.chatId,
            senderId: messages.senderId,
            format: messages.format,
            content: messages.content,
            metadata: messages.metadata,
            source: messages.source,
            createdAt: messages.createdAt,
          })
          .from(messages)
          .where(inArray(messages.chatId, chatIds))
          .orderBy(asc(messages.chatId), asc(messages.createdAt), asc(messages.id))
      : [];

  const messagesByChat = new Map<string, typeof messageRows>();
  for (const message of messageRows) {
    const existing = messagesByChat.get(message.chatId);
    if (existing) existing.push(message);
    else messagesByChat.set(message.chatId, [message]);
  }

  const trialRows = visibleAgents.map((agent) => {
    const metadata = parseLandingCampaignTrialAgentMetadata(agent.metadata);
    return {
      trialId: agent.uuid,
      agentId: agent.uuid,
      agentName: agent.name,
      displayName: agent.displayName,
      organizationId: agent.organizationId,
      clientId: agent.clientId,
      campaign: metadata?.campaign ?? input.campaign,
      skillSetId: metadata?.skillSetId ?? null,
      skillSetVersion: metadata?.skillSetVersion ?? null,
      repo: metadata?.repo ?? null,
      status: agent.status,
      runtimeProvider: agent.runtimeProvider,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  });

  const summaryRows = visibleChats.map((chat) => {
    const trial = parseLandingCampaignTrialChatMetadata(chat.metadata);
    const rows = messagesByChat.get(chat.chatId) ?? [];
    const counted = summarizeMessages(rows, agentIds, chat.createdAt);
    const lastMessageAt = chat.lastMessageAt ?? rows.at(-1)?.createdAt ?? null;
    return {
      trialId: chat.trialAgentId,
      chatId: chat.chatId,
      organizationId: chat.organizationId,
      campaign: trial?.campaign ?? input.campaign,
      agentId: trial?.agentId ?? chat.trialAgentId,
      agentName: agentById.get(chat.trialAgentId)?.name ?? null,
      topic: chat.topic ? redactString(chat.topic) : null,
      description: chat.description ? redactString(chat.description) : null,
      state: trial?.state ?? null,
      awaitingUserKind: trial?.awaitingUserKind ?? null,
      inputLocked: trial?.inputLocked ?? null,
      completedAgentTurns: trial?.completedAgentTurns ?? null,
      maxAgentTurns: trial?.maxAgentTurns ?? null,
      estimatedTokensUsed: trial?.estimatedTokensUsed ?? null,
      maxEstimatedTokens: trial?.maxEstimatedTokens ?? null,
      limitReason: trial?.limitReason ?? null,
      repo: trial?.repo ?? null,
      outcome: inferOutcome(trial?.state ?? null, counted.humanMessageCount),
      humanMessageCount: counted.humanMessageCount,
      agentMessageCount: counted.agentMessageCount,
      systemMessageCount: counted.systemMessageCount,
      totalMessageCount: rows.length,
      firstHumanMessageAt: counted.firstHumanMessageAt?.toISOString() ?? null,
      firstHumanResponseSeconds: counted.firstHumanResponseSeconds,
      hasLikelyReportLink: rows.some((message) => contentToText(message.content).includes("http")),
      createdAt: chat.createdAt.toISOString(),
      lastMessageAt: lastMessageAt?.toISOString() ?? null,
      durationSeconds: lastMessageAt ? secondsBetween(chat.createdAt, lastMessageAt) : null,
    };
  });

  const messageExportRows = input.includeMessages
    ? messageRows.map((message) => {
        const senderRole = classifySender(message.senderId, message.source, message.metadata, agentIds);
        const text = contentToText(message.content);
        return {
          chatId: message.chatId,
          messageId: message.id,
          trialId: chatById.get(message.chatId)?.trialAgentId ?? null,
          createdAt: message.createdAt.toISOString(),
          senderId: message.senderId,
          senderRole,
          format: message.format,
          source: message.source,
          contentLength: text.length,
          metadata: redactValue(message.metadata, input.redaction),
          ...(input.redaction === "metadata_only" ? {} : { content: redactValue(message.content, input.redaction) }),
        };
      })
    : [];

  const manifest = {
    exportId,
    createdAt,
    schemaVersion: 1,
    request: {
      clientId: input.clientId,
      agentName: input.agentName,
      campaign: input.campaign,
      from: input.from?.toISOString() ?? null,
      to: input.to?.toISOString() ?? null,
      includeMessages: input.includeMessages,
      redaction: input.redaction,
    },
    authorization: {
      model: "caller must be active admin in each exported agent organization",
      requestedAgentCount: candidateAgents.length,
      exportedAgentCount: visibleAgents.length,
    },
    counts: {
      trials: trialRows.length,
      chats: summaryRows.length,
      messages: messageExportRows.length,
    },
    files: [
      "manifest.json",
      "trials.ndjson",
      "summaries.ndjson",
      ...(input.includeMessages ? ["messages.ndjson"] : []),
    ],
  };

  return {
    exportId,
    createdByUserId: userId,
    createdAt,
    status: "completed",
    manifest,
    files: {
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "trials.ndjson": toNdjson(trialRows),
      "summaries.ndjson": toNdjson(summaryRows),
      ...(input.includeMessages ? { "messages.ndjson": toNdjson(messageExportRows) } : {}),
    },
  };
}

function summarizeMessages(
  rows: Array<{ senderId: string; source: string; metadata: Record<string, unknown>; createdAt: Date }>,
  trialAgentIds: Set<string>,
  chatCreatedAt: Date,
) {
  let humanMessageCount = 0;
  let agentMessageCount = 0;
  let systemMessageCount = 0;
  let firstHumanMessageAt: Date | null = null;

  for (const row of rows) {
    const role = classifySender(row.senderId, row.source, row.metadata, trialAgentIds);
    if (role === "agent") agentMessageCount += 1;
    else if (role === "system") systemMessageCount += 1;
    else {
      humanMessageCount += 1;
      firstHumanMessageAt ??= row.createdAt;
    }
  }

  return {
    humanMessageCount,
    agentMessageCount,
    systemMessageCount,
    firstHumanMessageAt,
    firstHumanResponseSeconds: firstHumanMessageAt ? secondsBetween(chatCreatedAt, firstHumanMessageAt) : null,
  };
}

function classifySender(
  senderId: string,
  source: string,
  metadata: Record<string, unknown>,
  trialAgentIds: Set<string>,
): "agent" | "human_or_other" | "system" {
  if (trialAgentIds.has(senderId)) return "agent";
  if (source === "system" || metadata.system === true) return "system";
  return "human_or_other";
}

function inferOutcome(
  state: string | null,
  humanMessageCount: number,
): "completed" | "failed" | "awaiting_user" | "abandoned" | "running" | "unknown" {
  if (state === "completed") return "completed";
  if (state === "failed") return "failed";
  if (state === "awaiting_user") return "awaiting_user";
  if (state === "running") return humanMessageCount === 0 ? "abandoned" : "running";
  return "unknown";
}

function secondsBetween(start: Date, end: Date): number {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 1000));
}

function toNdjson(rows: unknown[]): string {
  return rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function contentToText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function redactValue(value: unknown, mode: ScanCampaignExportRequest["redaction"]): unknown {
  if (mode === "metadata_only") return redactMetadata(value);
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, mode));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, isSensitiveKey(key) ? "[REDACTED]" : redactValue(child, mode)]),
    );
  }
  return value;
}

function redactMetadata(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactMetadata);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, isSensitiveKey(key) ? "[REDACTED]" : redactMetadata(child)]),
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /(?:api[_-]?key|token|secret|password|authorization|credential)/i.test(key);
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(
      /((?:api[_-]?key|token|secret|password|authorization|credential)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi,
      "$1[REDACTED]",
    );
}
