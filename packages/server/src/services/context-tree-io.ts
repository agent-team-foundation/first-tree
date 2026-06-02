import { posix } from "node:path";
import {
  type ContextTreeIoAction,
  type ContextTreeIoBucket,
  type ContextTreeIoCandidate,
  type ContextTreeIoEvent,
  type ContextTreeIoSummary,
  type ContextTreeIoTargetKind,
  contextTreeIoCandidateSchema,
  contextTreeIoSourceSchema,
  type SessionEvent,
  sessionEventSchema,
} from "@first-tree/shared";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { contextTreeIoEvents } from "../db/schema/context-tree-io-events.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { getOrgContextTree } from "./org-settings.js";

const CONTEXT_TREE_IO_FEED_LIMIT = 50;
const CLAUDE_READ_TOOLS = new Set(["Read", "NotebookRead"]);
const CLAUDE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

export type ContextTreeIoViewer = {
  humanAgentId: string;
  memberId: string;
};

export type RecordContextTreeIoInput = {
  organizationId: string;
  agentId: string;
  chatId: string;
  runtimeProvider: string;
  sessionEvent: {
    id: string;
    kind: string;
    payload: unknown;
    createdAt: string;
  };
};

type CandidateRecord = {
  candidate: ContextTreeIoCandidate;
  sourceIndex: number;
};

type NormalizedCandidate = {
  action: ContextTreeIoAction;
  source: ContextTreeIoCandidate["source"];
  treeRepoUrl: string;
  treeBranch: string;
  targetKind: ContextTreeIoTargetKind;
  targetPath: string;
  metadata: Record<string, unknown>;
};

function canonicalRepoUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  const scpLike = /^(?:[^@/\s]+@)?([^:]+):(.+)$/.exec(trimmed);
  if (scpLike && !trimmed.includes("://")) {
    const host = scpLike[1];
    const rawPath = scpLike[2];
    if (!host || !rawPath) return null;
    const path = normalizeRepoPath(rawPath);
    return path ? `${host.toLowerCase()}/${path}` : null;
  }

  try {
    const url = new URL(trimmed);
    const path = normalizeRepoPath(url.pathname);
    return path ? `${url.hostname.toLowerCase()}/${path}` : null;
  } catch {
    return null;
  }
}

function normalizeRepoPath(rawPath: string): string | null {
  let path = rawPath.replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.endsWith(".git")) path = path.slice(0, -4);
  return path.length > 0 ? path : null;
}

function normalizeTargetPath(rawPath: string, targetKind: ContextTreeIoTargetKind): string | null {
  const trimmed = rawPath.trim().replaceAll("\\", "/");
  if (trimmed.length === 0 || trimmed.includes("\0")) return null;
  if (targetKind === "repo" && (trimmed === "/" || trimmed === ".")) return "/";
  if (trimmed.startsWith("/")) return null;

  const normalized = posix.normalize(trimmed);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized.length === 0) return null;
  return normalized;
}

function isClaudeRuntime(runtimeProvider: string): boolean {
  return runtimeProvider === "claude-code" || runtimeProvider === "claude-code-tui";
}

function candidateMatchesEvent(
  candidate: ContextTreeIoCandidate,
  event: SessionEvent,
  runtimeProvider: string,
): boolean {
  if (candidate.source === "legacy_context_tree_usage") {
    return event.kind === "context_tree_usage" && candidate.action === "read";
  }
  if (event.kind !== "tool_call") return false;

  const toolName = event.payload.name;
  if (candidate.source === "codex_file_change") {
    return runtimeProvider === "codex" && toolName === "file_change" && candidate.action === "write";
  }
  if (candidate.source === "claude_read_tool") {
    return isClaudeRuntime(runtimeProvider) && CLAUDE_READ_TOOLS.has(toolName) && candidate.action === "read";
  }
  if (candidate.source === "claude_write_tool") {
    return isClaudeRuntime(runtimeProvider) && CLAUDE_WRITE_TOOLS.has(toolName) && candidate.action === "write";
  }
  if (candidate.source === "shell_command") {
    // P1 only: shell read candidates need a server-side command parser before
    // they can become trusted facts. Until then, ignore client-provided shell
    // candidates even when the runtime/tool shape looks plausible.
    return false;
  }
  return false;
}

function legacyCandidate(
  event: SessionEvent,
  bindingRepo: string,
  bindingBranch: string,
): ContextTreeIoCandidate | null {
  if (event.kind !== "context_tree_usage") return null;
  const nodePath = event.payload.nodePath;
  return {
    action: "read",
    source: "legacy_context_tree_usage",
    treeRepoUrl: event.payload.treeRepoUrl ?? bindingRepo,
    treeBranch: bindingBranch,
    targetKind: nodePath ? "file" : "repo",
    targetPath: nodePath ?? "/",
    metadata: {},
  };
}

function extractCandidates(event: SessionEvent, bindingRepo: string, bindingBranch: string): CandidateRecord[] {
  const legacy = legacyCandidate(event, bindingRepo, bindingBranch);
  if (legacy) return [{ candidate: legacy, sourceIndex: 0 }];

  if (event.kind !== "tool_call" || event.payload.status !== "ok") return [];
  const candidates = event.payload.contextTreeIo ?? [];
  const records: CandidateRecord[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    if (candidate) records.push({ candidate, sourceIndex: index });
  }
  return records;
}

function normalizeCandidate(
  candidate: ContextTreeIoCandidate,
  bindingRepo: string,
  bindingBranch: string,
  event: SessionEvent,
  runtimeProvider: string,
): NormalizedCandidate | null {
  const parsed = contextTreeIoCandidateSchema.safeParse(candidate);
  if (!parsed.success) return null;
  if (!candidateMatchesEvent(parsed.data, event, runtimeProvider)) return null;

  const expectedRepo = canonicalRepoUrl(bindingRepo);
  const reportedRepo = canonicalRepoUrl(parsed.data.treeRepoUrl);
  if (!expectedRepo || !reportedRepo || expectedRepo !== reportedRepo) return null;

  const targetPath = normalizeTargetPath(parsed.data.targetPath, parsed.data.targetKind);
  if (!targetPath) return null;

  return {
    action: parsed.data.action,
    source: parsed.data.source,
    treeRepoUrl: bindingRepo,
    treeBranch: parsed.data.treeBranch ?? bindingBranch,
    targetKind: parsed.data.targetKind,
    targetPath,
    metadata: parsed.data.metadata ?? {},
  };
}

export async function recordFromSessionEvent(db: Database, input: RecordContextTreeIoInput): Promise<void> {
  const binding = await getOrgContextTree(db, input.organizationId);
  if (!binding.repo) return;
  const bindingBranch = binding.branch ?? "main";

  const event = sessionEventSchema.parse({ kind: input.sessionEvent.kind, payload: input.sessionEvent.payload });
  const candidates = extractCandidates(event, binding.repo, bindingBranch);
  if (candidates.length === 0) return;

  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, input.chatId), eq(chats.organizationId, input.organizationId)))
    .limit(1);
  if (!chat) return;

  const createdAt = new Date(input.sessionEvent.createdAt);
  const rows = [];
  for (const { candidate, sourceIndex } of candidates) {
    const normalized = normalizeCandidate(candidate, binding.repo, bindingBranch, event, input.runtimeProvider);
    if (!normalized) continue;
    rows.push({
      id: `${input.sessionEvent.id}:${sourceIndex}`,
      organizationId: input.organizationId,
      agentId: input.agentId,
      chatId: input.chatId,
      sourceSessionEventId: input.sessionEvent.id,
      sourceIndex,
      runtimeProvider: input.runtimeProvider,
      action: normalized.action,
      source: normalized.source,
      treeRepoUrl: normalized.treeRepoUrl,
      treeBranch: normalized.treeBranch,
      targetKind: normalized.targetKind,
      targetPath: normalized.targetPath,
      metadata: normalized.metadata,
      createdAt,
    });
  }

  if (rows.length === 0) return;
  await db
    .insert(contextTreeIoEvents)
    .values(rows)
    .onConflictDoNothing({
      target: [contextTreeIoEvents.sourceSessionEventId, contextTreeIoEvents.sourceIndex],
    });
}

async function backfillLegacyContextTreeUsage(db: Database, organizationId: string, since: Date): Promise<void> {
  const rows = await db
    .select({
      id: sessionEvents.id,
      agentId: sessionEvents.agentId,
      chatId: sessionEvents.chatId,
      kind: sessionEvents.kind,
      payload: sessionEvents.payload,
      createdAt: sessionEvents.createdAt,
      runtimeProvider: agents.runtimeProvider,
    })
    .from(sessionEvents)
    .innerJoin(agents, eq(agents.uuid, sessionEvents.agentId))
    .where(
      and(
        eq(agents.organizationId, organizationId),
        eq(sessionEvents.kind, "context_tree_usage"),
        gte(sessionEvents.createdAt, since),
        sql`NOT EXISTS (
          SELECT 1
          FROM context_tree_io_events existing
          WHERE existing.source_session_event_id = ${sessionEvents.id}
        )`,
      ),
    );

  for (const row of rows) {
    await recordFromSessionEvent(db, {
      organizationId,
      agentId: row.agentId,
      chatId: row.chatId,
      runtimeProvider: row.runtimeProvider,
      sessionEvent: {
        id: row.id,
        kind: row.kind,
        payload: row.payload,
        createdAt: isoOrNull(row.createdAt) ?? new Date().toISOString(),
      },
    });
  }
}

function allEventsSql(organizationId: string, sinceIso: string) {
  return sql`
    WITH all_events AS (
      SELECT
        e.id,
        e.agent_id,
        a.display_name AS agent_name,
        a.avatar_color_token AS agent_avatar_color_token,
        e.runtime_provider,
        e.action,
        e.source,
        e.target_kind,
        e.target_path,
        e.chat_id,
        e.created_at
      FROM context_tree_io_events e
      INNER JOIN agents a ON a.uuid = e.agent_id
      WHERE e.organization_id = ${organizationId}
        AND e.created_at >= ${sinceIso}::timestamptz
    )
  `;
}

function emptyBucket(): ContextTreeIoBucket {
  return { agentCount: 0, eventCount: 0, targetCount: 0 };
}

function numberFrom(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function accessibleChatIdSet(db: Database, viewer: ContextTreeIoViewer, chatIds: string[]): Promise<Set<string>> {
  const accessible = new Set<string>();
  if (chatIds.length === 0) return accessible;

  const directRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .where(and(inArray(chatMembership.chatId, chatIds), eq(chatMembership.agentId, viewer.humanAgentId)));
  for (const row of directRows) accessible.add(row.chatId);

  const supervisedRows = await db
    .select({ chatId: chatMembership.chatId })
    .from(chatMembership)
    .innerJoin(agents, eq(agents.uuid, chatMembership.agentId))
    .where(
      and(
        inArray(chatMembership.chatId, chatIds),
        eq(chatMembership.accessMode, "speaker"),
        eq(agents.managerId, viewer.memberId),
      ),
    );
  for (const row of supervisedRows) accessible.add(row.chatId);

  return accessible;
}

export async function summarizeContextTreeIo(
  db: Database,
  organizationId: string,
  windowDays: number,
  viewer?: ContextTreeIoViewer,
): Promise<ContextTreeIoSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  await backfillLegacyContextTreeUsage(db, organizationId, since);

  const countRows = await db.execute<{
    action: string;
    agent_count: number;
    event_count: number;
    target_count: number;
  }>(sql`
    ${allEventsSql(organizationId, sinceIso)}
    SELECT
      action,
      count(DISTINCT agent_id)::int AS agent_count,
      count(*)::int AS event_count,
      count(DISTINCT target_path)::int AS target_count
    FROM all_events
    GROUP BY action
  `);

  const summary = {
    read: emptyBucket(),
    write: emptyBucket(),
  };
  for (const row of countRows) {
    if (row.action !== "read" && row.action !== "write") continue;
    summary[row.action] = {
      agentCount: numberFrom(row.agent_count),
      eventCount: numberFrom(row.event_count),
      targetCount: numberFrom(row.target_count),
    };
  }

  const agentRows = await db.execute<{
    agent_id: string;
    agent_name: string;
    agent_avatar_color_token: string | null;
    runtime_provider: string;
    read_count: number;
    write_count: number;
    last_read_at: Date | string | null;
    last_write_at: Date | string | null;
    last_event_at: Date | string;
  }>(sql`
    ${allEventsSql(organizationId, sinceIso)}
    SELECT
      agent_id,
      agent_name,
      agent_avatar_color_token,
      runtime_provider,
      count(*) FILTER (WHERE action = 'read')::int AS read_count,
      count(*) FILTER (WHERE action = 'write')::int AS write_count,
      max(created_at) FILTER (WHERE action = 'read') AS last_read_at,
      max(created_at) FILTER (WHERE action = 'write') AS last_write_at,
      max(created_at) AS last_event_at
    FROM all_events
    GROUP BY agent_id, agent_name, agent_avatar_color_token, runtime_provider
    ORDER BY last_event_at DESC
  `);

  const recentRows = await db.execute<{
    id: string;
    agent_id: string;
    agent_name: string;
    agent_avatar_color_token: string | null;
    runtime_provider: string;
    action: string;
    source: string;
    target_kind: string;
    target_path: string;
    raw_chat_id: string;
    joined_chat_id: string | null;
    chat_topic: string | null;
    created_at: Date | string;
  }>(sql`
    ${allEventsSql(organizationId, sinceIso)}
    SELECT
      all_events.id,
      all_events.agent_id,
      all_events.agent_name,
      all_events.agent_avatar_color_token,
      all_events.runtime_provider,
      all_events.action,
      all_events.source,
      all_events.target_kind,
      all_events.target_path,
      all_events.chat_id AS raw_chat_id,
      c.id AS joined_chat_id,
      c.topic AS chat_topic,
      all_events.created_at
    FROM all_events
    LEFT JOIN chats c ON c.id = all_events.chat_id AND c.organization_id = ${organizationId}
    ORDER BY all_events.created_at DESC
    LIMIT ${CONTEXT_TREE_IO_FEED_LIMIT}
  `);

  const inOrgChatIds = [
    ...new Set(recentRows.filter((row) => row.joined_chat_id !== null).map((row) => row.raw_chat_id)),
  ];
  const accessibleChatIds = viewer ? await accessibleChatIdSet(db, viewer, inOrgChatIds) : new Set<string>();

  const recentEvents: ContextTreeIoEvent[] = recentRows.map((row) => {
    const sameOrgChat = row.joined_chat_id !== null;
    return {
      id: row.id,
      agentId: row.agent_id,
      agentName: row.agent_name,
      agentAvatarColorToken: row.agent_avatar_color_token,
      runtimeProvider: row.runtime_provider,
      action: row.action === "write" ? "write" : "read",
      source: contextTreeIoSourceSchema.parse(row.source),
      targetKind: row.target_kind === "directory" || row.target_kind === "repo" ? row.target_kind : "file",
      targetPath: row.target_path,
      chatId: sameOrgChat ? row.raw_chat_id : null,
      chatTitle: sameOrgChat ? row.chat_topic : null,
      viewerCanAccess: sameOrgChat && accessibleChatIds.has(row.raw_chat_id),
      createdAt: isoOrNull(row.created_at) ?? new Date().toISOString(),
    };
  });

  return {
    windowDays,
    summary,
    agents: agentRows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      agentAvatarColorToken: row.agent_avatar_color_token,
      runtimeProvider: row.runtime_provider,
      readCount: numberFrom(row.read_count),
      writeCount: numberFrom(row.write_count),
      lastReadAt: isoOrNull(row.last_read_at),
      lastWriteAt: isoOrNull(row.last_write_at),
    })),
    recentEvents,
  };
}
