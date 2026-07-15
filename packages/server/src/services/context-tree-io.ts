import { posix } from "node:path";
import {
  type ContextTreeIoAction,
  type ContextTreeIoBucket,
  type ContextTreeIoEvent,
  type ContextTreeIoSkipBreakdown,
  type ContextTreeIoSkipReason,
  type ContextTreeIoSkipSummary,
  type ContextTreeIoSource,
  type ContextTreeIoSummary,
  type ContextTreeIoTargetKind,
  type ContextTreeWriteEvent,
  canonicalGitRepoUrl,
  classifyShellCommandIo,
  contextTreeIoSourceSchema,
  type SessionEvent,
  sessionEventSchema,
  type ToolFileRef,
  toolFileRefSchema,
} from "@first-tree/shared";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { contextTreeIoEvents } from "../db/schema/context-tree-io-events.js";
import { sessionEvents } from "../db/schema/session-events.js";
import { createLogger } from "../observability/index.js";
import { type TimingSink, timeSyncWithSink, timeWithSink } from "../observability/timing.js";
import { getOrgContextTreeBinding } from "./org-settings.js";

const CONTEXT_TREE_IO_FEED_LIMIT = 50;
// Grep/Glob count as reads at the granularity their refs carry: the client
// emits one directory-level ref for the explicit search root, never one ref
// per matched file (see the client's TREE_SEARCH_TOOL_NAMES).
const CLAUDE_READ_TOOLS = new Set(["Read", "NotebookRead", "Grep", "Glob"]);
const CLAUDE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// Cursor's handler-emitted tool names. Interpreted ONLY when
// `runtimeProvider === "cursor"` — the lowercase names deliberately do not
// collide with claude's capitalized tools or codex's `command`/`file_change`.
const CURSOR_READ_TOOLS = new Set(["read"]);
const CURSOR_WRITE_TOOLS = new Set(["edit", "write"]);
const CONTEXT_TREE_IO_TOOL_NAMES = [
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "MultiEdit",
  "NotebookEdit",
  "NotebookRead",
  "Read",
  "Write",
  "command",
  "edit",
  "file_change",
  "read",
  "shell",
  "write",
];
const log = createLogger("ContextTreeIo");
const GIT_STATUS_DELTA_REF_ORIGIN = "git_status_delta";
const GIT_STATUS_DELTA_DERIVATION: EventIoDerivation = { action: "write", source: "git_status_delta" };

export type ContextTreeIoViewer = {
  humanAgentId: string;
  memberId: string;
};

type ContextTreeIoBinding = {
  repo?: string | null;
  branch?: string | null;
};

export type ContextTreeIoSummaryOptions = {
  timing?: TimingSink;
  backfillSessionEvents?: boolean;
  contextTreeBinding?: ContextTreeIoBinding;
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

type FileRefRecord = {
  ref: ToolFileRef;
  sourceIndex: number;
};

type EventIoDerivation = {
  action: ContextTreeIoAction;
  source: ContextTreeIoSource;
};

type NormalizedFileRef = {
  treeRepoUrl: string;
  treeBranch: string;
  targetKind: ContextTreeIoTargetKind;
  targetPath: string;
  metadata: Record<string, unknown>;
};

type NormalizedFileRefRecord = {
  normalized: NormalizedFileRef;
  sourceIndex: number;
  derivation: EventIoDerivation;
};

type ContextTreeIoCandidateAgent = {
  agentId: string;
  runtimeProvider: string;
};

export type ContextTreeIoDecision =
  | {
      recordable: true;
    }
  | {
      recordable: false;
      reason: ContextTreeIoSkipReason;
    };

export type ExplainContextTreeIoDecisionInput = {
  runtimeProvider: string;
  sessionEvent: {
    kind: string;
    payload: unknown;
  };
  bindingRepo: string | null | undefined;
  bindingBranch?: string | null;
  chatInOrg?: boolean;
};

type InternalContextTreeIoDecision =
  | {
      recordable: true;
      derivation: EventIoDerivation;
      refs: NormalizedFileRefRecord[];
    }
  | {
      recordable: false;
      reason: ContextTreeIoSkipReason;
    };

type SkippedDecisionFastPath =
  | {
      handled: true;
      decision: ContextTreeIoDecision;
      toolName: string | null;
    }
  | {
      handled: false;
    };

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

function shellCommandArg(event: SessionEvent): string | null {
  if (event.kind !== "tool_call") return null;
  const args = event.payload.args;
  if (!args || typeof args !== "object") return null;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function shellToolCanRead(event: SessionEvent): boolean {
  const command = shellCommandArg(event);
  if (command === null) return false;
  const classification = classifyShellCommandIo(command);
  return classification.supported && classification.action === "read";
}

function isShellTool(runtimeProvider: string, toolName: string): boolean {
  return (
    (runtimeProvider === "codex" && toolName === "command") ||
    (runtimeProvider === "cursor" && toolName === "shell") ||
    (isClaudeRuntime(runtimeProvider) && toolName === "Bash")
  );
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function skippedDecisionFastPathForNoRefs(
  kind: string,
  payload: unknown,
  runtimeProvider: string,
  bindingRepo: string | null | undefined,
): SkippedDecisionFastPath {
  if (!bindingRepo) return { handled: false };
  if (kind !== "tool_call") return { handled: false };

  const record = recordFromUnknown(payload);
  if (!record) return { handled: false };
  const toolName = typeof record.name === "string" ? record.name : null;
  if (typeof record.toolUseId !== "string" || !toolName) return { handled: false };
  if (record.status !== "ok") {
    return { handled: true, decision: { recordable: false, reason: "status_not_ok" }, toolName };
  }
  if ("toolFileRefs" in record) {
    if (!Array.isArray(record.toolFileRefs)) return { handled: false };
    if (record.toolFileRefs.length > 0) return { handled: false };
  }

  if (runtimeProvider === "codex" && toolName === "file_change") {
    return { handled: true, decision: { recordable: false, reason: "no_tool_file_refs" }, toolName };
  }
  if (runtimeProvider === "cursor" && (CURSOR_READ_TOOLS.has(toolName) || CURSOR_WRITE_TOOLS.has(toolName))) {
    return { handled: true, decision: { recordable: false, reason: "no_tool_file_refs" }, toolName };
  }
  if (isClaudeRuntime(runtimeProvider) && (CLAUDE_READ_TOOLS.has(toolName) || CLAUDE_WRITE_TOOLS.has(toolName))) {
    return { handled: true, decision: { recordable: false, reason: "no_tool_file_refs" }, toolName };
  }
  if (isShellTool(runtimeProvider, toolName)) {
    const args = recordFromUnknown(record.args);
    const command = typeof args?.command === "string" ? args.command : null;
    const classification = command ? classifyShellCommandIo(command) : null;
    const reason =
      classification?.supported && classification.action === "read" ? "no_tool_file_refs" : "unsupported_shell_command";
    return { handled: true, decision: { recordable: false, reason }, toolName };
  }

  return { handled: true, decision: { recordable: false, reason: "unsupported_tool" }, toolName };
}

function deriveEventIo(event: SessionEvent, runtimeProvider: string): EventIoDerivation | ContextTreeIoSkipReason {
  if (event.kind === "context_tree_usage") return { action: "read", source: "legacy_context_tree_usage" };
  if (event.kind !== "tool_call") return "event_kind_not_io";
  if (event.payload.status !== "ok") return "status_not_ok";

  const toolName = event.payload.name;
  if (runtimeProvider === "codex" && toolName === "file_change") {
    return { action: "write", source: "codex_file_change" };
  }
  if (runtimeProvider === "cursor" && CURSOR_READ_TOOLS.has(toolName)) {
    return { action: "read", source: "cursor_read_tool" };
  }
  if (runtimeProvider === "cursor" && CURSOR_WRITE_TOOLS.has(toolName)) {
    return { action: "write", source: "cursor_write_tool" };
  }
  if (isClaudeRuntime(runtimeProvider) && CLAUDE_READ_TOOLS.has(toolName)) {
    return { action: "read", source: "claude_read_tool" };
  }
  if (isClaudeRuntime(runtimeProvider) && CLAUDE_WRITE_TOOLS.has(toolName)) {
    return { action: "write", source: "claude_write_tool" };
  }
  if (isShellTool(runtimeProvider, toolName)) {
    return shellToolCanRead(event) ? { action: "read", source: "shell_command" } : "unsupported_shell_command";
  }

  return "unsupported_tool";
}

function legacyFileRef(event: SessionEvent, bindingRepo: string, bindingBranch: string): ToolFileRef | null {
  if (event.kind !== "context_tree_usage") return null;
  const nodePath = event.payload.nodePath;
  return {
    origin: "runtime_metadata",
    repoUrl: event.payload.treeRepoUrl ?? bindingRepo,
    repoBranch: bindingBranch,
    repoRelativePath: nodePath ?? "/",
    pathKind: nodePath ? "file" : "repo",
  };
}

function extractFileRefs(event: SessionEvent, bindingRepo: string, bindingBranch: string): FileRefRecord[] {
  const legacy = legacyFileRef(event, bindingRepo, bindingBranch);
  if (legacy) return [{ ref: legacy, sourceIndex: 0 }];

  if (event.kind !== "tool_call" || event.payload.status !== "ok") return [];
  const refs = event.payload.toolFileRefs ?? [];
  const records: FileRefRecord[] = [];
  for (let index = 0; index < refs.length; index++) {
    const ref = refs[index];
    if (ref) records.push({ ref, sourceIndex: index });
  }
  return records;
}

function normalizeFileRef(
  ref: ToolFileRef,
  bindingRepo: string,
  bindingBranch: string,
): { ok: true; normalized: NormalizedFileRef } | { ok: false; reason: ContextTreeIoSkipReason } {
  const parsed = toolFileRefSchema.safeParse(ref);
  if (!parsed.success) return { ok: false, reason: "ref_schema_invalid" };

  const expectedRepo = canonicalGitRepoUrl(bindingRepo);
  const reportedRepo = canonicalGitRepoUrl(parsed.data.repoUrl);
  if (!expectedRepo || !reportedRepo || expectedRepo !== reportedRepo) {
    return { ok: false, reason: "ref_repo_mismatch" };
  }

  const targetKind = parsed.data.pathKind ?? "file";
  if (!parsed.data.repoRelativePath) return { ok: false, reason: "ref_path_invalid" };
  const targetPath = normalizeTargetPath(parsed.data.repoRelativePath, targetKind);
  if (!targetPath) return { ok: false, reason: "ref_path_invalid" };

  return {
    ok: true,
    normalized: {
      treeRepoUrl: bindingRepo,
      treeBranch: parsed.data.repoBranch ?? bindingBranch,
      targetKind,
      targetPath,
      metadata: {
        ...(parsed.data.metadata ?? {}),
        origin: parsed.data.origin,
        ...(parsed.data.localPath ? { localPath: parsed.data.localPath } : {}),
      },
    },
  };
}

function buildContextTreeIoDecision(input: {
  event: SessionEvent;
  runtimeProvider: string;
  bindingRepo: string | null | undefined;
  bindingBranch: string;
  chatInOrg?: boolean;
}): InternalContextTreeIoDecision {
  if (!input.bindingRepo) return { recordable: false, reason: "no_org_context_tree_binding" };

  const refs = extractFileRefs(input.event, input.bindingRepo, input.bindingBranch);
  const hasGitStatusDeltaRef = refs.some(({ ref }) => ref.origin === GIT_STATUS_DELTA_REF_ORIGIN);
  const derivation = deriveEventIo(input.event, input.runtimeProvider);
  const baseDerivation = typeof derivation === "string" ? null : derivation;
  const derivationSkipReason = typeof derivation === "string" ? derivation : null;
  if (!baseDerivation && !hasGitStatusDeltaRef) {
    return { recordable: false, reason: derivationSkipReason ?? "unsupported_tool" };
  }
  if (refs.length === 0) return { recordable: false, reason: "no_tool_file_refs" };

  const normalizedRefs: NormalizedFileRefRecord[] = [];
  let firstRejectedReason: ContextTreeIoSkipReason | null = null;
  for (const { ref, sourceIndex } of refs) {
    const refDerivation = ref.origin === GIT_STATUS_DELTA_REF_ORIGIN ? GIT_STATUS_DELTA_DERIVATION : baseDerivation;
    if (!refDerivation) continue;
    const normalized = normalizeFileRef(ref, input.bindingRepo, input.bindingBranch);
    if (!normalized.ok) {
      firstRejectedReason ??= normalized.reason;
      continue;
    }
    normalizedRefs.push({ normalized: normalized.normalized, sourceIndex, derivation: refDerivation });
  }

  if (normalizedRefs.length === 0) {
    return { recordable: false, reason: firstRejectedReason ?? "ref_schema_invalid" };
  }
  if (input.chatInOrg === false) return { recordable: false, reason: "chat_not_in_org" };

  return { recordable: true, derivation: baseDerivation ?? GIT_STATUS_DELTA_DERIVATION, refs: normalizedRefs };
}

function toolNameOf(event: SessionEvent): string | null {
  return event.kind === "tool_call" ? event.payload.name : null;
}

function incrementCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function listContextTreeIoCandidateAgents(
  db: Database,
  organizationId: string,
  timing: TimingSink | undefined,
  stage: string,
): Promise<ContextTreeIoCandidateAgent[]> {
  const rows = await timeWithSink(
    timing,
    `${stage}_agents`,
    () =>
      db
        .select({
          agentId: agents.uuid,
          runtimeProvider: agents.runtimeProvider,
        })
        .from(agents)
        .where(eq(agents.organizationId, organizationId)),
    { organizationId },
  );
  timing?.(`${stage}_agents_rows`, 0, { agentCount: rows.length });
  return rows;
}

function sortedCountEntries(
  map: Map<string, number>,
  keyName: "runtimeProvider" | "toolName",
): Array<{ runtimeProvider: string; eventCount: number } | { toolName: string; eventCount: number }> {
  return [...map.entries()]
    .sort(([leftKey, leftCount], [rightKey, rightCount]) => rightCount - leftCount || leftKey.localeCompare(rightKey))
    .map(([key, eventCount]) => ({ [keyName]: key, eventCount })) as Array<
    { runtimeProvider: string; eventCount: number } | { toolName: string; eventCount: number }
  >;
}

export function explainContextTreeIoDecision(input: ExplainContextTreeIoDecisionInput): ContextTreeIoDecision {
  const parsed = sessionEventSchema.safeParse({
    kind: input.sessionEvent.kind,
    payload: input.sessionEvent.payload,
  });
  if (!parsed.success) return { recordable: false, reason: "event_kind_not_io" };

  const decision = buildContextTreeIoDecision({
    event: parsed.data,
    runtimeProvider: input.runtimeProvider,
    bindingRepo: input.bindingRepo,
    bindingBranch: input.bindingBranch ?? "main",
    chatInOrg: input.chatInOrg,
  });
  return decision.recordable ? { recordable: true } : { recordable: false, reason: decision.reason };
}

export async function summarizeContextTreeIoSkippedEvents(
  db: Database,
  organizationId: string,
  windowDays: number,
  options: ContextTreeIoSummaryOptions = {},
): Promise<ContextTreeIoSkipSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const binding =
    options.contextTreeBinding ??
    (await timeWithSink(options.timing, "io_skipped_binding", () => getOrgContextTreeBinding(db, organizationId), {
      organizationId,
    })) ??
    {};
  const bindingBranch = binding.branch ?? "main";
  const candidateAgents = await listContextTreeIoCandidateAgents(db, organizationId, options.timing, "io_skipped");
  const runtimeProviderByAgent = new Map(candidateAgents.map((agent) => [agent.agentId, agent.runtimeProvider]));
  if (candidateAgents.length === 0) {
    options.timing?.("io_skipped_rows", 0, { rowCount: 0 });
    return { windowDays, totalEventCount: 0, reasons: [] };
  }
  const rows = await timeWithSink(options.timing, "io_skipped_scan", () =>
    db
      .select({
        id: sessionEvents.id,
        agentId: sessionEvents.agentId,
        chatId: sessionEvents.chatId,
        kind: sessionEvents.kind,
        payload: sessionEvents.payload,
        chatOrganizationId: chats.organizationId,
      })
      .from(sessionEvents)
      .leftJoin(chats, eq(chats.id, sessionEvents.chatId))
      .where(
        and(
          inArray(
            sessionEvents.agentId,
            candidateAgents.map((agent) => agent.agentId),
          ),
          gte(sessionEvents.createdAt, since),
          or(
            eq(sessionEvents.kind, "context_tree_usage"),
            and(
              eq(sessionEvents.kind, "tool_call"),
              sql`${sessionEvents.payload}->>'status' = 'ok'`,
              or(
                inArray(sql<string>`${sessionEvents.payload}->>'name'`, CONTEXT_TREE_IO_TOOL_NAMES),
                sql`CASE
                  WHEN jsonb_typeof(${sessionEvents.payload}->'toolFileRefs') = 'array'
                  THEN jsonb_array_length(${sessionEvents.payload}->'toolFileRefs')
                  ELSE 0
                END > 0`,
              ),
            ),
          ),
          sql`NOT EXISTS (
            SELECT 1
            FROM context_tree_io_events existing
            WHERE existing.source_session_event_id = ${sessionEvents.id}
          )`,
        ),
      ),
  );
  options.timing?.("io_skipped_rows", 0, { rowCount: rows.length });

  const byReason = new Map<
    ContextTreeIoSkipReason,
    {
      eventCount: number;
      agentIds: Set<string>;
      runtimeProviders: Map<string, number>;
      toolNames: Map<string, number>;
    }
  >();

  const recordSkippedDecision = (
    decision: ContextTreeIoDecision,
    row: (typeof rows)[number],
    toolName: string | null,
  ): void => {
    if (decision.recordable) return;

    const bucket = byReason.get(decision.reason) ?? {
      eventCount: 0,
      agentIds: new Set<string>(),
      runtimeProviders: new Map<string, number>(),
      toolNames: new Map<string, number>(),
    };
    bucket.eventCount += 1;
    bucket.agentIds.add(row.agentId);
    incrementCount(bucket.runtimeProviders, runtimeProviderByAgent.get(row.agentId) ?? "unknown");
    if (toolName) incrementCount(bucket.toolNames, toolName);
    byReason.set(decision.reason, bucket);
  };

  let fastPathRows = 0;
  let slowPathRows = 0;
  timeSyncWithSink(
    options.timing,
    "io_skipped_decide",
    () => {
      for (const row of rows) {
        const runtimeProvider = runtimeProviderByAgent.get(row.agentId) ?? "unknown";
        const fastPath = skippedDecisionFastPathForNoRefs(row.kind, row.payload, runtimeProvider, binding.repo);
        if (fastPath.handled) {
          fastPathRows += 1;
          recordSkippedDecision(fastPath.decision, row, fastPath.toolName);
          continue;
        }
        slowPathRows += 1;
        const parsed = sessionEventSchema.safeParse({ kind: row.kind, payload: row.payload });
        const event = parsed.success ? parsed.data : null;
        const decision = event
          ? buildContextTreeIoDecision({
              event,
              runtimeProvider,
              bindingRepo: binding.repo,
              bindingBranch,
              chatInOrg: row.chatOrganizationId === organizationId,
            })
          : ({ recordable: false, reason: "event_kind_not_io" } as const);
        recordSkippedDecision(decision, row, event ? toolNameOf(event) : null);
      }
    },
    { rowCount: rows.length },
  );
  options.timing?.("io_skipped_decide_fast_rows", 0, { rowCount: fastPathRows });
  options.timing?.("io_skipped_decide_slow_rows", 0, { rowCount: slowPathRows });

  const reasons = [...byReason.entries()]
    .sort(
      ([leftReason, left], [rightReason, right]) =>
        right.eventCount - left.eventCount || leftReason.localeCompare(rightReason),
    )
    .map(
      ([reason, bucket]): ContextTreeIoSkipBreakdown => ({
        reason,
        eventCount: bucket.eventCount,
        agentCount: bucket.agentIds.size,
        runtimeProviders: sortedCountEntries(bucket.runtimeProviders, "runtimeProvider") as Array<{
          runtimeProvider: string;
          eventCount: number;
        }>,
        toolNames: sortedCountEntries(bucket.toolNames, "toolName") as Array<{ toolName: string; eventCount: number }>,
      }),
    );

  return {
    windowDays,
    totalEventCount: reasons.reduce((sum, row) => sum + row.eventCount, 0),
    reasons,
  };
}

export async function recordFromSessionEvent(db: Database, input: RecordContextTreeIoInput): Promise<void> {
  const binding: ContextTreeIoBinding = (await getOrgContextTreeBinding(db, input.organizationId)) ?? {};
  const bindingBranch = binding.branch ?? "main";

  const event = sessionEventSchema.parse({ kind: input.sessionEvent.kind, payload: input.sessionEvent.payload });
  const decision = buildContextTreeIoDecision({
    event,
    runtimeProvider: input.runtimeProvider,
    bindingRepo: binding.repo,
    bindingBranch,
  });
  if (!decision.recordable) {
    log.debug(
      {
        reason: decision.reason,
        organizationId: input.organizationId,
        agentId: input.agentId,
        chatId: input.chatId,
        sessionEventId: input.sessionEvent.id,
        runtimeProvider: input.runtimeProvider,
        eventKind: event.kind,
        toolName: toolNameOf(event),
      },
      "context tree io event skipped",
    );
    return;
  }

  const [chat] = await db
    .select({ id: chats.id })
    .from(chats)
    .where(and(eq(chats.id, input.chatId), eq(chats.organizationId, input.organizationId)))
    .limit(1);
  if (!chat) {
    log.debug(
      {
        reason: "chat_not_in_org",
        organizationId: input.organizationId,
        agentId: input.agentId,
        chatId: input.chatId,
        sessionEventId: input.sessionEvent.id,
        runtimeProvider: input.runtimeProvider,
        eventKind: event.kind,
        toolName: toolNameOf(event),
      },
      "context tree io event skipped",
    );
    return;
  }

  const createdAt = new Date(input.sessionEvent.createdAt);
  const rows = [];
  for (const { normalized, sourceIndex, derivation } of decision.refs) {
    rows.push({
      id: `${input.sessionEvent.id}:${sourceIndex}`,
      organizationId: input.organizationId,
      agentId: input.agentId,
      chatId: input.chatId,
      sourceSessionEventId: input.sessionEvent.id,
      sourceIndex,
      runtimeProvider: input.runtimeProvider,
      action: derivation.action,
      source: derivation.source,
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

async function backfillContextTreeIoSessionEvents(
  db: Database,
  organizationId: string,
  since: Date,
  options: ContextTreeIoSummaryOptions = {},
): Promise<void> {
  const candidateAgents = await listContextTreeIoCandidateAgents(db, organizationId, options.timing, "io_backfill");
  const runtimeProviderByAgent = new Map(candidateAgents.map((agent) => [agent.agentId, agent.runtimeProvider]));
  if (candidateAgents.length === 0) {
    options.timing?.("io_backfill_rows", 0, { rowCount: 0 });
    return;
  }
  const rows = await timeWithSink(options.timing, "io_backfill_scan", () =>
    db
      .select({
        id: sessionEvents.id,
        agentId: sessionEvents.agentId,
        chatId: sessionEvents.chatId,
        kind: sessionEvents.kind,
        payload: sessionEvents.payload,
        createdAt: sessionEvents.createdAt,
      })
      .from(sessionEvents)
      .where(
        and(
          inArray(
            sessionEvents.agentId,
            candidateAgents.map((agent) => agent.agentId),
          ),
          or(
            eq(sessionEvents.kind, "context_tree_usage"),
            and(
              eq(sessionEvents.kind, "tool_call"),
              sql`${sessionEvents.payload}->>'status' = 'ok'`,
              sql`EXISTS (
                SELECT 1
                FROM jsonb_array_elements(
                  CASE
                    WHEN jsonb_typeof(${sessionEvents.payload}->'toolFileRefs') = 'array'
                    THEN ${sessionEvents.payload}->'toolFileRefs'
                    ELSE '[]'::jsonb
                  END
                ) AS ref
                WHERE ref ? 'repoUrl' AND ref ? 'repoRelativePath'
              )`,
            ),
          ),
          gte(sessionEvents.createdAt, since),
          sql`NOT EXISTS (
            SELECT 1
            FROM context_tree_io_events existing
            WHERE existing.source_session_event_id = ${sessionEvents.id}
          )`,
        ),
      ),
  );
  options.timing?.("io_backfill_rows", 0, { rowCount: rows.length });

  await timeWithSink(
    options.timing,
    "io_backfill_record",
    async () => {
      for (const row of rows) {
        await recordFromSessionEvent(db, {
          organizationId,
          agentId: row.agentId,
          chatId: row.chatId,
          runtimeProvider: runtimeProviderByAgent.get(row.agentId) ?? "unknown",
          sessionEvent: {
            id: row.id,
            kind: row.kind,
            payload: row.payload,
            createdAt: isoOrNull(row.createdAt) ?? new Date().toISOString(),
          },
        });
      }
    },
    { rowCount: rows.length },
  );
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

type ReconcileTelemetryWrite = {
  agentId: string;
  agentName: string;
  agentAvatarColorToken: string | null;
  createdAtMs: number;
  createdAtIso: string;
  // Human-facing node path (case preserved) for telemetry-only rows.
  displayPath: string;
};

// Sentinel key for the root node. The root's git node path is "" and its file
// path is "NODE.md"; both must collapse to the SAME key (root is the tree's
// highest-signal node, so a root edit must reconcile, not split into two rows).
// A non-empty sentinel also keeps root out of the "skip empty key" path.
const ROOT_NODE_KEY = "<root>";

// Human-facing node path: strip a leading slash, the `.md` suffix, and a
// trailing `NODE` segment (so `members/x/NODE.md` → `members/x`, `NODE.md` and
// `/` → "" for root). Case preserved — used for display, not matching.
function displayNodePath(path: string | null): string {
  if (!path) return "";
  return path
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.md$/i, "")
    .replace(/(^|\/)NODE$/i, "");
}

// Normalize a tree path to a stable per-node key so git paths and telemetry
// paths compare equal: `system/x.md`, `/system/x`, `system/x/NODE.md` all map
// to `system/x`; `NODE.md`, ``, and `/` all map to ROOT_NODE_KEY.
function normalizeNodeKey(path: string | null): string {
  const display = displayNodePath(path);
  return display === "" ? ROOT_NODE_KEY : display.toLowerCase();
}

function titleFromNodePath(path: string): string {
  const last = path.split("/").filter(Boolean).at(-1);
  if (!last) return "Context Tree";
  return last.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function writeSortKey(event: ContextTreeWriteEvent): number {
  if (!event.createdAt) return 0;
  const parsed = Date.parse(event.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Reconcile git-derived writes (complete, including PR merges, but lacking
 * agent identity — git only knows the committer) with session write telemetry
 * (which carries the agent that authored the change). Produces one row per
 * changed node for the window:
 *
 *   - git write + matching telemetry → agent-attributed, with commit / PR / risk
 *   - git write, no telemetry match   → honest git author + commit / PR (a human
 *     or a GitHub merge identity; we do not invent an agent)
 *   - telemetry write, no git commit  → in-flight agent write (no commit / PR)
 *
 * Dedupe key is the normalized node path within the window, so a worktree edit
 * and the PR merge that lands it collapse into a single row instead of double-
 * counting. Reuses the already-computed git `writes`; the only added cost is
 * one indexed telemetry query, so the snapshot's git cache stays untouched.
 */
export async function reconcileContextTreeWrites(
  db: Database,
  organizationId: string,
  windowDays: number,
  gitWrites: ContextTreeWriteEvent[],
  options: ContextTreeIoSummaryOptions = {},
): Promise<ContextTreeWriteEvent[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  if (options.backfillSessionEvents !== false) {
    await timeWithSink(options.timing, "write_reconcile_backfill", () =>
      backfillContextTreeIoSessionEvents(db, organizationId, since, options),
    );
  }

  const writeRows = await timeWithSink(options.timing, "write_reconcile_query", () =>
    db.execute<{
      agent_id: string;
      agent_name: string;
      agent_avatar_color_token: string | null;
      target_path: string;
      created_at: Date | string;
    }>(sql`
      ${allEventsSql(organizationId, sinceIso)}
      SELECT
        all_events.agent_id,
        all_events.agent_name,
        all_events.agent_avatar_color_token,
        all_events.target_path,
        all_events.created_at
      FROM all_events
      WHERE all_events.action = 'write'
      ORDER BY all_events.created_at ASC
    `),
  );
  options.timing?.("write_reconcile_rows", 0, { rowCount: writeRows.length, gitWriteCount: gitWrites.length });

  const telemetryByKey = new Map<string, ReconcileTelemetryWrite[]>();
  for (const row of writeRows) {
    const key = normalizeNodeKey(row.target_path);
    const iso = isoOrNull(row.created_at);
    const createdAtMs = iso ? Date.parse(iso) : Number.NaN;
    const list = telemetryByKey.get(key) ?? [];
    list.push({
      agentId: row.agent_id,
      agentName: row.agent_name,
      agentAvatarColorToken: row.agent_avatar_color_token,
      createdAtMs: Number.isNaN(createdAtMs) ? 0 : createdAtMs,
      createdAtIso: iso ?? new Date().toISOString(),
      displayPath: displayNodePath(row.target_path),
    });
    telemetryByKey.set(key, list);
  }

  const reconciled: ContextTreeWriteEvent[] = [];
  // Process git writes oldest-first so each landed commit consumes only the
  // telemetry that preceded IT; a later in-flight edit on the same node stays
  // available for the telemetry-only pass instead of being attached to (and
  // then hidden behind) an older commit.
  const gitWritesOldestFirst = [...gitWrites].sort((a, b) => writeSortKey(a) - writeSortKey(b));
  for (const write of gitWritesOldestFirst) {
    const key = normalizeNodeKey(write.nodePath);
    const rows = telemetryByKey.get(key) ?? [];
    const commitMs = write.createdAt ? Date.parse(write.createdAt) : Number.NaN;
    // Only telemetry at or before the landing commit can be the edit that
    // commit captured. When the git timestamp is missing, treat every row as a
    // candidate (we can't order them). A write with no qualifying telemetry
    // keeps its honest git author and consumes nothing.
    const matched = Number.isNaN(commitMs) ? rows : rows.filter((r) => r.createdAtMs <= commitMs);
    if (matched.length === 0) {
      reconciled.push(write);
      continue;
    }
    const attribution = matched.reduce((best, c) => (c.createdAtMs >= best.createdAtMs ? c : best));
    reconciled.push({
      ...write,
      agentId: attribution.agentId,
      agentName: attribution.agentName,
      agentAvatarColorToken: attribution.agentAvatarColorToken,
    });
    // Leave later (post-commit) telemetry for the telemetry-only pass.
    telemetryByKey.set(key, Number.isNaN(commitMs) ? [] : rows.filter((r) => r.createdAtMs > commitMs));
  }

  // Telemetry-only writes: a node an agent wrote that has no matching landed
  // commit in the window (typically an in-flight worktree edit). One row per
  // node, attributed, with no commit / PR.
  for (const rows of telemetryByKey.values()) {
    if (rows.length === 0) continue;
    const latest = rows.reduce((best, c) => (c.createdAtMs >= best.createdAtMs ? c : best));
    reconciled.push({
      id: `telemetry:${latest.displayPath}:${latest.createdAtIso}`,
      nodeId: null,
      nodePath: latest.displayPath,
      title: titleFromNodePath(latest.displayPath),
      changeType: "edited",
      summary: null,
      riskLevel: "low",
      authorName: null,
      agentId: latest.agentId,
      agentName: latest.agentName,
      agentAvatarColorToken: latest.agentAvatarColorToken,
      commit: null,
      prNumber: null,
      createdAt: latest.createdAtIso,
    });
  }

  reconciled.sort((a, b) => writeSortKey(b) - writeSortKey(a));
  return reconciled;
}

export async function summarizeContextTreeIo(
  db: Database,
  organizationId: string,
  windowDays: number,
  viewer?: ContextTreeIoViewer,
  options: ContextTreeIoSummaryOptions = {},
): Promise<ContextTreeIoSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  if (options.backfillSessionEvents !== false) {
    await timeWithSink(options.timing, "io_backfill", () =>
      backfillContextTreeIoSessionEvents(db, organizationId, since, options),
    );
  }

  const countRows = await timeWithSink(options.timing, "io_counts", () =>
    db.execute<{
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
    `),
  );

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

  const agentRows = await timeWithSink(options.timing, "io_agents", () =>
    db.execute<{
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
    `),
  );

  const recentRows = await timeWithSink(options.timing, "io_recent_reads", () =>
    db.execute<{
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
      WHERE all_events.action = 'read'
      ORDER BY all_events.created_at DESC
      LIMIT ${CONTEXT_TREE_IO_FEED_LIMIT}
    `),
  );

  const inOrgChatIds = [
    ...new Set(recentRows.filter((row) => row.joined_chat_id !== null).map((row) => row.raw_chat_id)),
  ];
  const accessibleChatIds = viewer
    ? await timeWithSink(options.timing, "io_accessible_chats", () => accessibleChatIdSet(db, viewer, inOrgChatIds), {
        chatCount: inOrgChatIds.length,
      })
    : new Set<string>();

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
  const skipped = await timeWithSink(options.timing, "io_skipped", () =>
    summarizeContextTreeIoSkippedEvents(db, organizationId, windowDays, options),
  );

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
    // Writes are git-derived, not telemetry-derived. This service owns reads +
    // the summary buckets + the per-agent table; `buildContextTreeIoSummary`
    // fills `writes` via reconcileContextTreeWrites against the git history.
    writes: [],
    writesTotal: 0,
    skipped,
  };
}

/**
 * Full IO summary for a snapshot route: telemetry-sourced reads / summary /
 * agents / skipped, plus git-derived writes (the snapshot's `io.writes`)
 * reconciled against write telemetry for agent attribution. Both the org-scoped
 * and the user-primary-org snapshot routes go through here so the write feed
 * never silently empties on one of them.
 */
export async function buildContextTreeIoSummary(
  db: Database,
  organizationId: string,
  windowDays: number,
  gitWrites: ContextTreeWriteEvent[],
  viewer?: ContextTreeIoViewer,
  options: ContextTreeIoSummaryOptions = {},
): Promise<ContextTreeIoSummary> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  await timeWithSink(options.timing, "io_backfill", () =>
    backfillContextTreeIoSessionEvents(db, organizationId, since, options),
  );
  const downstreamOptions = { ...options, backfillSessionEvents: false };
  const io = await summarizeContextTreeIo(db, organizationId, windowDays, viewer, downstreamOptions);
  const writes = await timeWithSink(options.timing, "write_reconcile", () =>
    reconcileContextTreeWrites(db, organizationId, windowDays, gitWrites, downstreamOptions),
  );
  return { ...io, writes, writesTotal: writes.length };
}
