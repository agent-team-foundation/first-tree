import { randomUUID } from "node:crypto";
import {
  landingCampaignSlugSchema,
  parseLandingCampaignTrialAgentMetadata,
  parseLandingCampaignTrialChatMetadata,
} from "@first-tree/shared";
import { redactCredentialText } from "@first-tree/shared/observability";
import { and, asc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../../db/connection.js";
import { agents, chatMembership, chats, members, messages } from "../../db/schema/index.js";
import { BadRequestError, ForbiddenError } from "../../errors.js";
import { requireUser } from "../../scope/require-user.js";
import { assertOfficialLandingCampaignClient } from "../../services/landing-campaigns/guards.js";

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
  createdAt: string;
  status: "completed";
  manifest: Record<string, unknown>;
  files: Partial<Record<ExportFileName, string>>;
};

const MAX_AGENT_ROWS = 5_000;
const MAX_CHAT_ROWS = 10_000;
const MAX_MESSAGE_ROWS = 50_000;
const MAX_EXPORT_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGE_CONTENT_BYTES = 25 * 1024 * 1024;
const MAX_PRELOAD_VARIABLE_BYTES = 25 * 1024 * 1024;

/**
 * Internal landing-campaign analytics authorization class.
 *
 * `/internal` is only a route namespace; it is not an authorization boundary.
 * This export is cross-tenant because trial agents live in customer
 * organizations, so each request must prove current active membership in the
 * configured landing-campaign service organization. Any role in that trusted
 * service org is intentionally sufficient, and the query remains constrained
 * to the configured official client plus valid landing-campaign trial metadata.
 */
export async function scanCampaignExportRoutes(app: FastifyInstance): Promise<void> {
  app.post("/", { config: { otelRecordBody: true } }, async (request, reply) => {
    const { userId } = requireUser(request);
    const body = scanCampaignExportRequestSchema.parse(request.body);
    const officialClientId = await requireInternalAnalyticsAccess(app, userId);
    if (body.clientId !== officialClientId) {
      throw new ForbiddenError("Scan campaign exports are restricted to the configured landing campaign client.");
    }
    const record = await buildScanCampaignExport(app, body);
    return reply.status(200).send(record);
  });
}

async function requireInternalAnalyticsAccess(app: FastifyInstance, userId: string): Promise<string> {
  const serviceConfig = app.config.growth.landingCampaigns;
  const serviceUserId = serviceConfig?.serviceUserId;
  const serviceOrgId = serviceConfig?.serviceOrgId;
  const officialClientId = serviceConfig?.clientId;
  if (!serviceUserId || !serviceOrgId || !officialClientId) {
    throw new ForbiddenError("Landing campaign internal analytics is not configured.");
  }
  await assertOfficialLandingCampaignClient(app.db, officialClientId, serviceUserId, serviceOrgId);

  const [membership] = await app.db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, serviceOrgId), eq(members.status, "active")))
    .limit(1);
  if (!membership) {
    throw new ForbiddenError("Landing campaign internal analytics requires active service organization membership.");
  }

  return officialClientId;
}

async function buildScanCampaignExport(app: FastifyInstance, input: ScanCampaignExportRequest): Promise<ExportRecord> {
  return app.db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
    return buildScanCampaignExportFromDb(tx as unknown as Database, input);
  });
}

async function buildScanCampaignExportFromDb(db: Database, input: ScanCampaignExportRequest): Promise<ExportRecord> {
  const exportId = randomUUID();
  const createdAt = new Date().toISOString();

  const candidateAgentPreflightRows = await db
    .select({
      uuid: agents.uuid,
      variableBytes: sql<number>`
        (
          octet_length(${agents.uuid}) +
          octet_length(coalesce(${agents.name}, '')) +
          octet_length(${agents.organizationId}) +
          octet_length(${agents.displayName}) +
          octet_length(${agents.status}) +
          octet_length(coalesce(${agents.clientId}, '')) +
          octet_length(${agents.runtimeProvider}) +
          octet_length(${agents.metadata}::text)
        )::int
      `,
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
    .orderBy(asc(agents.createdAt), asc(agents.uuid))
    .limit(MAX_AGENT_ROWS + 1);

  assertRowLimit(candidateAgentPreflightRows, MAX_AGENT_ROWS, "trial agents");
  assertVariableByteLimit(candidateAgentPreflightRows, MAX_PRELOAD_VARIABLE_BYTES, "trial agent metadata");
  const candidateAgentIds = candidateAgentPreflightRows.slice(0, MAX_AGENT_ROWS).map((agent) => agent.uuid);
  const candidateAgentRows =
    candidateAgentIds.length > 0
      ? await db
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
          .where(inArray(agents.uuid, candidateAgentIds))
      : [];
  const candidateAgentById = new Map(candidateAgentRows.map((agent) => [agent.uuid, agent]));
  const candidateAgents = candidateAgentIds.flatMap((id) => {
    const agent = candidateAgentById.get(id);
    return agent ? [agent] : [];
  });
  const visibleAgents = candidateAgents.filter(
    (agent) => parseLandingCampaignTrialAgentMetadata(agent.metadata)?.campaign === input.campaign,
  );
  const visibleAgentIds = visibleAgents.map((agent) => agent.uuid);
  const agentById = new Map(visibleAgents.map((agent) => [agent.uuid, agent]));
  const agentIds = new Set(visibleAgentIds);

  const chatPreflightRows =
    visibleAgentIds.length === 0
      ? []
      : await db
          .select({
            chatId: chats.id,
            trialAgentId: chatMembership.agentId,
            variableBytes: sql<number>`
              (
                octet_length(${chats.id}) +
                octet_length(${chats.organizationId}) +
                octet_length(${chatMembership.agentId}) +
                octet_length(coalesce(${chats.topic}, '')) +
                octet_length(coalesce(${chats.description}, '')) +
                octet_length(${chats.metadata}::text)
              )::int
            `,
          })
          .from(chatMembership)
          .innerJoin(chats, eq(chatMembership.chatId, chats.id))
          .where(
            and(
              inArray(chatMembership.agentId, visibleAgentIds),
              eq(chatMembership.accessMode, "speaker"),
              sql`${chats.metadata}->'landingCampaignTrial'->>'campaign' = ${input.campaign}`,
              sql`${chats.metadata}->'landingCampaignTrial'->>'agentId' = ${chatMembership.agentId}`,
              input.from ? gte(chats.createdAt, input.from) : undefined,
              input.to ? lte(chats.createdAt, input.to) : undefined,
            ),
          )
          .orderBy(asc(chats.createdAt), asc(chats.id))
          .limit(MAX_CHAT_ROWS + 1);

  assertRowLimit(chatPreflightRows, MAX_CHAT_ROWS, "trial chats");
  assertVariableByteLimit(chatPreflightRows, MAX_PRELOAD_VARIABLE_BYTES, "trial chat metadata");
  const chatIdsForContent = [...new Set(chatPreflightRows.slice(0, MAX_CHAT_ROWS).map((chat) => chat.chatId))];
  const chatContentRows =
    chatIdsForContent.length > 0
      ? await db
          .select({
            chatId: chats.id,
            organizationId: chats.organizationId,
            topic: chats.topic,
            description: chats.description,
            metadata: chats.metadata,
            lastMessageAt: chats.lastMessageAt,
            createdAt: chats.createdAt,
          })
          .from(chats)
          .where(inArray(chats.id, chatIdsForContent))
      : [];
  const chatContentById = new Map(chatContentRows.map((chat) => [chat.chatId, chat]));
  const chatRows = chatPreflightRows.flatMap((chat) => {
    const content = chatContentById.get(chat.chatId);
    return content ? [{ ...content, trialAgentId: chat.trialAgentId }] : [];
  });

  const chatById = new Map<string, (typeof chatRows)[number]>();
  for (const row of chatRows) {
    if (!chatById.has(row.chatId)) chatById.set(row.chatId, row);
  }
  const visibleChats = [...chatById.values()].filter((chat) => {
    const trial = parseLandingCampaignTrialChatMetadata(chat.metadata);
    const agent = agentById.get(chat.trialAgentId);
    return (
      trial?.campaign === input.campaign &&
      trial.agentId === chat.trialAgentId &&
      agent?.organizationId === chat.organizationId
    );
  });
  const chatIds = visibleChats.map((chat) => chat.chatId);

  const messageMetadataRows =
    chatIds.length > 0
      ? await db
          .select({
            id: messages.id,
            chatId: messages.chatId,
            senderId: messages.senderId,
            format: messages.format,
            source: messages.source,
            createdAt: messages.createdAt,
            variableBytes: sql<number>`
              (
                octet_length(${messages.id}) +
                octet_length(${messages.chatId}) +
                octet_length(${messages.senderId}) +
                octet_length(${messages.format}) +
                octet_length(${messages.source}) +
                octet_length(${messages.metadata}::text) +
                octet_length(${messages.content}::text)
              )::int
            `,
            metadataBytes: sql<number>`octet_length(${messages.metadata}::text)::int`,
            contentBytes: sql<number>`octet_length(${messages.content}::text)::int`,
          })
          .from(messages)
          .where(inArray(messages.chatId, chatIds))
          .orderBy(asc(messages.chatId), asc(messages.createdAt), asc(messages.id))
          .limit(MAX_MESSAGE_ROWS + 1)
      : [];

  assertRowLimit(messageMetadataRows, MAX_MESSAGE_ROWS, "trial messages");
  assertContentByteLimit(messageMetadataRows);

  const messageIds = messageMetadataRows.map((message) => message.id);
  const contentByMessageId =
    messageIds.length > 0
      ? new Map(
          (
            await db
              .select({ id: messages.id, metadata: messages.metadata, content: messages.content })
              .from(messages)
              .where(inArray(messages.id, messageIds))
          ).map((message) => [message.id, { metadata: message.metadata, content: message.content }]),
        )
      : new Map<string, { metadata: Record<string, unknown>; content: unknown }>();

  const messageRows = messageMetadataRows.map((message) => ({
    ...message,
    metadata: contentByMessageId.get(message.id)?.metadata ?? {},
    content: contentByMessageId.get(message.id)?.content ?? null,
  }));

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
      attemptId: trial?.attribution?.attemptId ?? null,
      variant: trial?.attribution?.variant ?? null,
      actionConverted: trial?.actionConversion !== undefined,
      actionChatId: trial?.actionConversion?.chatId ?? null,
      actionRecordedAt: trial?.actionConversion?.recordedAt ?? null,
      outcome: inferOutcome(trial?.state ?? null, counted.humanMessageCount),
      humanMessageCount: counted.humanMessageCount,
      agentMessageCount: counted.agentMessageCount,
      systemMessageCount: counted.systemMessageCount,
      totalMessageCount: rows.length,
      firstHumanMessageAt: counted.firstHumanMessageAt?.toISOString() ?? null,
      firstHumanResponseSeconds: counted.firstHumanResponseSeconds,
      hasLikelyReportLink: hasLikelyReportLink(rows, agentIds, trial?.repo ?? null),
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
    schemaVersion: 2,
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
      model:
        "caller must have current active membership in the configured landing campaign service organization; any role is allowed",
      exportedAgentCount: visibleAgents.length,
    },
    counts: {
      trials: trialRows.length,
      chats: summaryRows.length,
      messages: messageRows.length,
      exportedMessages: messageExportRows.length,
    },
    files: [
      "manifest.json",
      "trials.ndjson",
      "summaries.ndjson",
      ...(input.includeMessages ? ["messages.ndjson"] : []),
    ],
  };

  const files = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "trials.ndjson": toNdjson(trialRows),
    "summaries.ndjson": toNdjson(summaryRows),
    ...(input.includeMessages ? { "messages.ndjson": toNdjson(messageExportRows) } : {}),
  };
  assertExportByteLimit(files);

  return {
    exportId,
    createdAt,
    status: "completed",
    manifest,
    files,
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

function assertRowLimit(rows: unknown[], maxRows: number, label: string): void {
  if (rows.length <= maxRows) return;
  throw new BadRequestError(`Scan campaign export matched more than ${maxRows} ${label}; narrow the date range.`);
}

function assertVariableByteLimit(rows: Array<{ variableBytes: number }>, maxBytes: number, label: string): void {
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.variableBytes ?? 0), 0);
  if (totalBytes <= maxBytes) return;
  throw new BadRequestError(`Scan campaign export ${label} is larger than ${maxBytes} bytes; narrow the date range.`);
}

function assertContentByteLimit(rows: Array<{ variableBytes: number }>): void {
  const totalBytes = rows.reduce((sum, row) => sum + Number(row.variableBytes ?? 0), 0);
  if (totalBytes <= MAX_MESSAGE_CONTENT_BYTES) return;
  throw new BadRequestError(
    `Scan campaign export message data is larger than ${MAX_MESSAGE_CONTENT_BYTES} bytes; narrow the date range.`,
  );
}

function assertExportByteLimit(files: Partial<Record<ExportFileName, string>>): void {
  const totalBytes = Object.values(files).reduce((sum, content) => sum + Buffer.byteLength(content ?? "", "utf8"), 0);
  if (totalBytes <= MAX_EXPORT_BYTES) return;
  throw new BadRequestError(
    `Scan campaign export is larger than ${MAX_EXPORT_BYTES} bytes; disable messages or narrow the date range.`,
  );
}

function hasLikelyReportLink(
  rows: Array<{ senderId: string; source: string; metadata: Record<string, unknown>; content: unknown }>,
  trialAgentIds: Set<string>,
  repo: { url: string; canonicalKey: string } | null,
): boolean {
  return rows.some((message) => {
    if (classifySender(message.senderId, message.source, message.metadata, trialAgentIds) !== "agent") return false;
    return extractUrls(contentToText(message.content)).some((url) => !isTrialRepoUrl(url, repo));
  });
}

function extractUrls(text: string): string[] {
  return (text.match(/https?:\/\/[^\s)"'<>]+/gi) ?? []).map(stripTerminalUrlPunctuation);
}

function stripTerminalUrlPunctuation(url: string): string {
  return url.replace(/[.,;:!?]+$/g, "");
}

function isTrialRepoUrl(url: string, repo: { url: string; canonicalKey: string } | null): boolean {
  if (!repo) return false;
  const normalizedUrl = normalizeRepoLikeUrl(url);
  return normalizedUrl === normalizeRepoLikeUrl(repo.url) || normalizedUrl === normalizeRepoLikeUrl(repo.canonicalKey);
}

function normalizeRepoLikeUrl(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^git@([^:]+):/i, "$1/")
    .replace(/\.git$/i, "")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function classifySender(
  senderId: string,
  source: string,
  metadata: Record<string, unknown>,
  trialAgentIds: Set<string>,
): "agent" | "human_or_other" | "system" {
  if (trialAgentIds.has(senderId)) return "agent";
  if (source === "system" || metadata.system === true || typeof metadata.systemSender === "string") return "system";
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
  return redactCredentialText(value);
}
