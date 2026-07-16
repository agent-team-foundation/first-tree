import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  EffortLevel,
  McpServerConfig,
  PermissionMode,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentRuntimeConfigPayload,
  ReplaySafety,
  RuntimeProvider,
  SessionEvent,
  SupportedImageMime,
  ToolFileRef,
} from "@first-tree/shared";
import {
  encodeProviderRetryEventMessage,
  isImageBatchRefContent,
  isImageRefContent,
  runtimeProviderSchema,
  SUPPORTED_IMAGE_MIMES as SHARED_SUPPORTED_IMAGE_MIMES,
} from "@first-tree/shared";
import { ensureAgentBootstrap as ensureAgentBootstrapShared } from "../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { renderDocumentAttachmentsForLLM } from "../runtime/agent-io.js";
import { type PredeclaredSourceRepo, writeAgentBriefing } from "../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../runtime/chat-context.js";
import { renderChatContextPrompt, renderRuntimeOutputContract } from "../runtime/chat-context-section.js";
import { resolveContextTreeRelativePath, toolFileRefsFromShellCommand } from "../runtime/context-tree-file-refs.js";
import {
  type ContextTreeGitWriteTracker,
  createContextTreeGitWriteTracker,
} from "../runtime/context-tree-git-status.js";
import {
  type AgentHandler,
  type DeliveryToken,
  deliveryTokenFromSessionContext,
  type HandlerFactory,
  type SessionContext,
  type SessionMessage,
} from "../runtime/handler.js";
import { findImagePath } from "../runtime/image-store.js";
import { InputController } from "../runtime/input-controller.js";
import { ProviderAttempt, type ProviderAttemptSettlement } from "../runtime/provider-attempt.js";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  maxProviderTurnRetryAttempts,
  type ProviderFailureClassification,
  type ProviderRetryDecision,
} from "../runtime/provider-retry-policy.js";
import { redactErrorPreview } from "../runtime/redact-error-preview.js";
import { materializeResourceSkills } from "../runtime/resource-skills.js";
import {
  buildBriefingUpdateNotice,
  computeBriefingFingerprint,
  readSessionBriefingFingerprint,
  writeSessionBriefingFingerprint,
} from "../runtime/session-briefing-fingerprint.js";
import { currentSourceRepoNamesFromPayload, declaredSourceRepos } from "../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../runtime/workspace.js";
import { chunkAssistantText } from "./assistant-text.js";
import { formatAuthHint, isClaudeAuthError } from "./auth-error-hint.js";
import { resolveClaudeCodeExecutable } from "./claude-executable.js";
import {
  type ClaudeProviderFailure,
  claudeFailureFromAssistantMessage,
  claudeFailureFromSdkResult,
  isEgressForbiddenText,
  mergeClaudeProviderFailures,
} from "./claude-provider-error.js";
import { consumedErrorOutcome } from "./turn-settlement.js";

type PendingAckMessage = {
  message: SessionMessage;
  token: DeliveryToken;
  providerEntered: boolean;
};

type PendingSdkInput = {
  sdkMessage: SDKUserMessage;
  pendingAck: PendingAckMessage | null;
};

type QueuedInjectedMessage = {
  message: SessionMessage;
  token: DeliveryToken;
  recoveryReason?: string;
  recoveryRetried?: boolean;
};

/**
 * Bug 6: thrown by `consumeOutput` when an SDK "success" result message
 * actually contains an API error string (e.g. "API Error: socket
 * connection was closed unexpectedly"). The catch block treats this like
 * any other transient stream failure and respawns the query.
 */
export class StreamApiTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamApiTransientError";
  }
}

const STREAM_API_ERROR_PREFIXES = ["API Error:", "Claude API error:", "Anthropic API error:"];

const STREAM_API_ERROR_HINTS = [
  "socket connection",
  "fetch failed",
  "ECONNRESET",
  "ETIMEDOUT",
  "timeout",
  "overloaded",
  "rate limit",
  "Unauthorized",
  "Forbidden",
  "401",
  "403",
  "429",
  "5xx",
  "500",
  "502",
  "503",
  "504",
];

/**
 * Bug 6: detect when a Claude SDK `result.success` payload is in fact an
 * internal SDK error string forwarded as the model reply. The heuristic is
 * deliberately conservative — three constraints together — so we don't
 * mistake a user message that happens to discuss "API Error" for a real
 * failure:
 *
 *   1. The text MUST start with one of {@link STREAM_API_ERROR_PREFIXES}.
 *   2. The full payload MUST be under 500 chars (real model replies that
 *      mention "API Error:" as topic content are almost always longer
 *      than a single one-line dump from the SDK).
 *   3. The text MUST include at least one technical hint from
 *      {@link STREAM_API_ERROR_HINTS} (socket / fetch / status code etc.)
 *      so a short tutorial like `"API Error: how to handle them"` doesn't
 *      qualify.
 *
 * Returns the captured one-line message when all three match; `null`
 * otherwise.
 */
export function detectStreamApiError(text: string): { message: string } | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 500) return null;
  const hasPrefix = STREAM_API_ERROR_PREFIXES.some((p) => trimmed.startsWith(p));
  if (!hasPrefix) return null;
  const lower = trimmed.toLowerCase();
  const hasHint = STREAM_API_ERROR_HINTS.some((h) => lower.includes(h.toLowerCase()));
  if (!hasHint) return null;
  // Take only the first line so multi-line error dumps stay readable in logs.
  const firstLine = trimmed.split("\n")[0] ?? trimmed;
  return { message: firstLine };
}

const CLAUDE_SESSION_LIMIT_RESULT_RE =
  /^You(?:'|\u2019)ve hit your session limit\b(?:\s*(?:\u00b7|\u2022|-)\s*resets\s+.+)?\.?$/i;

/**
 * Claude Code can report account/session exhaustion as a `result.success`
 * payload instead of an SDK error. Treat only the exact runtime notice shape as
 * a provider capacity failure; normal assistant answers must still flow through
 * the retired final-text hook.
 */
export function detectClaudeSessionLimitResult(text: string): { message: string } | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length >= 500) return null;
  const firstLine = trimmed.split("\n")[0]?.trim() ?? "";
  if (firstLine.length === 0 || firstLine !== trimmed) return null;
  return CLAUDE_SESSION_LIMIT_RESULT_RE.test(firstLine) ? { message: firstLine } : null;
}

const TOOL_RESULT_PREVIEW_LIMIT = 400;

type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: unknown; is_error?: boolean };
type TextBlock = { type: "text"; text: string };
type ThinkingBlock = { type: "thinking"; thinking?: string };

const SUPPORTED_IMAGE_MIMES: ReadonlySet<SupportedImageMime> = new Set<SupportedImageMime>(
  SHARED_SUPPORTED_IMAGE_MIMES,
);

const MIME_TO_EXT: Record<SupportedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Legacy pre-refactor image content with base64 inlined into the message.
 * Only exercised by messages that pre-date the image-out-of-messages PR —
 * kept so a client upgraded mid-backlog can still read them. */
type LegacyImageFileContent = {
  data: string;
  mimeType: SupportedImageMime;
  filename: string;
  size?: number;
};

function isLegacyImageFileContent(content: unknown): content is LegacyImageFileContent {
  if (!content || typeof content !== "object") return false;
  const c = content as Record<string, unknown>;
  return (
    typeof c.data === "string" &&
    typeof c.mimeType === "string" &&
    typeof c.filename === "string" &&
    SUPPORTED_IMAGE_MIMES.has(c.mimeType as SupportedImageMime)
  );
}

/** chat_id values are DB-generated UUIDs; reject anything else so we never
 * traverse out of the images dir if the field is ever tampered with. */
function sanitizeChatId(chatId: string): string {
  return /^[a-zA-Z0-9-]+$/.test(chatId) ? chatId : "unknown";
}

/**
 * Write a legacy inline-base64 image to a temp file so Claude Code's Read
 * tool can pick it up. Only the legacy path — new messages reference an
 * `attachments` row whose bytes are fetched to the data dir before delivery
 * (see SessionManager.ensureImagesLocal).
 */
async function writeLegacyImageToTempFile(content: LegacyImageFileContent, chatId: string): Promise<string> {
  const dir = join(tmpdir(), "first-tree", "images", sanitizeChatId(chatId));
  await mkdir(dir, { recursive: true });
  const ext = MIME_TO_EXT[content.mimeType];
  const path = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
  await writeFile(path, Buffer.from(content.data, "base64"));
  return path;
}

function extractContentBlocks(message: unknown): unknown[] {
  if (!message || typeof message !== "object") return [];
  const inner = (message as { message?: unknown }).message;
  if (!inner || typeof inner !== "object") return [];
  const content = (inner as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
}

function isToolUseBlock(block: unknown): block is ToolUseBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string";
}

function isToolResultBlock(block: unknown): block is ToolResultBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "tool_result" && typeof b.tool_use_id === "string";
}

function isTextBlock(block: unknown): block is TextBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "text" && typeof b.text === "string";
}

function isThinkingBlock(block: unknown): block is ThinkingBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return b.type === "thinking";
}

function eventMakesReplayUnsafe(event: SessionEvent): boolean {
  return event.kind === "assistant_text" || event.kind === "thinking" || event.kind === "tool_call";
}

type ResultMessage = {
  type: "result";
  subtype: string;
  result?: string;
  errors?: string[];
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  // Per-model cumulative token usage for the current SDK Query. Anthropic's
  // Claude Agent SDK populates this on every ResultMessage (success and error
  // subtypes). A single turn can span multiple models (e.g. fast-mode), so the
  // handler diffs consecutive snapshots and emits one `token_usage` delta per
  // changed model. Keys are model identifiers (e.g. "claude-opus-4-7"). Older
  // SDK versions may omit the field entirely — treat absence as "no usage to
  // emit" rather than an error.
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
};

type ClaudeModelUsageCounters = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
};

function isResultMessage(message: unknown): message is ResultMessage {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return m.type === "result" && typeof m.subtype === "string";
}

/**
 * Extract the typed auth-failure signal from any SDK message shape that
 * carries `SDKAssistantMessageError`. Returns the original provider-side
 * message (when the SDK has one to share) so the chat-timeline hint can
 * quote it verbatim.
 *
 * Two sources we watch (per `@anthropic-ai/claude-agent-sdk` `sdk.d.ts`):
 *
 *   - `assistant` messages with `error === "authentication_failed"` — the
 *     turn's terminal auth-failure signal, emitted from the typed union.
 *   - `auth_status` messages with a non-empty `error` string — the dedicated
 *     auth-state surface.
 *
 * `system/api_retry` is deliberately NOT watched here: that message fires
 * BEFORE the SDK's next retry attempt, not as a final verdict on the turn,
 * and would surface a hint before the user knew the turn failed. If a retry
 * does succeed, the hint would have been a false alarm. The eventual
 * `assistant.error` or `result.subtype === "error"` is the authoritative
 * post-failure signal — let those drive the chat-timeline message.
 */
export function detectClaudeAuthFailure(message: unknown): { rawMessage: string } | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m.type === "assistant" && isClaudeAuthError(m.error as string | undefined)) {
    return { rawMessage: "authentication_failed" };
  }
  if (m.type === "auth_status" && typeof m.error === "string" && m.error.length > 0) {
    return { rawMessage: m.error };
  }
  return null;
}

/**
 * Diff a Query's cumulative `modelUsage` snapshots and emit one `token_usage`
 * event per changed model. The baseline is scoped to the concrete SDK Query:
 * a respawn/resume starts from an empty baseline because the new native process
 * owns a fresh cumulative counter. The SDK lumps cache-creation tokens under
 * their own field, but the wire schema folds their delta into `inputTokens`
 * because they bill as input.
 *
 * Best-effort: a missing/empty `modelUsage` is silently skipped (older SDKs
 * and some error subtypes don't populate it). Per-entry emit failures are
 * swallowed so token accounting never blocks the turn close that follows.
 */
function emitTokenUsageFromResult(
  message: ResultMessage,
  sessionCtx: SessionContext,
  baseline: Map<string, ClaudeModelUsageCounters>,
): void {
  const usage = message.modelUsage;
  if (!usage) return;
  for (const [model, m] of Object.entries(usage)) {
    if (!m) continue;
    const current: ClaudeModelUsageCounters = {
      inputTokens: m.inputTokens ?? 0,
      outputTokens: m.outputTokens ?? 0,
      cacheReadInputTokens: m.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: m.cacheCreationInputTokens ?? 0,
    };
    const previous = baseline.get(model);
    baseline.set(model, current);
    const delta = (key: keyof ClaudeModelUsageCounters): number => {
      const value = current[key];
      const prior = previous?.[key] ?? 0;
      // Defensive reset handling: if a provider counter ever rolls back within
      // one Query, treat the new value as the start of a fresh counter rather
      // than dropping the usage or emitting a negative schema value.
      return value >= prior ? value - prior : value;
    };
    const inputTokens = delta("inputTokens") + delta("cacheCreationInputTokens");
    const cachedRead = delta("cacheReadInputTokens");
    const outputTokens = delta("outputTokens");
    if (inputTokens === 0 && cachedRead === 0 && outputTokens === 0) continue;
    try {
      sessionCtx.emitEvent({
        kind: "token_usage",
        payload: {
          provider: "claude-code",
          model,
          inputTokens,
          cachedInputTokens: cachedRead,
          outputTokens,
        },
      });
    } catch (err) {
      sessionCtx.log(`Failed to emit token_usage: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

/** Tools whose `file_path` / `notebook_path` argument names a single file. */
const TREE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "NotebookRead"]);
const TREE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/**
 * Search/discovery tools scan a search root rather than open one file. They
 * carry directory-level evidence (the explicit `path` argument), deliberately
 * NOT one ref per matched file — a recursive search "touching" every node
 * would drown the Context tab feed in noise.
 */
const TREE_SEARCH_TOOL_NAMES: ReadonlySet<string> = new Set(["Grep", "Glob"]);

/**
 * Extract a string `file_path` argument from a tool_use input, if present.
 * Notebook tools (NotebookRead / NotebookEdit) spell the same argument
 * `notebook_path`; accept either so notebook IO carries refs too.
 */
function readFilePathArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as { file_path?: unknown; notebook_path?: unknown };
  const fp = record.file_path ?? record.notebook_path;
  return typeof fp === "string" ? fp : null;
}

/**
 * If `filePath` lives under `contextTreePath`, return its tree-root-relative
 * path (e.g. `members/Gandy2025/NODE.md`); otherwise null. The agent reads
 * tree files by absolute path (CLAUDE.md points it at the full tree at
 * `contextTreePath`), so a prefix match on the normalised root is the filter.
 * The trailing-slash trim keeps `/a/tree` from matching `/a/tree-other/x`.
 *
 * Invariant: both `filePath` and `contextTreePath` are expected to be
 * absolute. A relative `filePath` will not match the absolute root and returns
 * null — i.e. it silently under-counts (fails safe) rather than mis-attributing.
 *
 * Callers that may receive symlink aliases of the tree (the W1 cloud layout
 * exposes the shared clone as a `<workspace>/context-tree` link) must pass
 * both arguments through `canonicalizeFsPath` first — this function compares
 * strings only.
 */
export function treeNodePathOf(filePath: string, contextTreePath: string): string | null {
  if (!filePath || !contextTreePath) return null;
  const root = contextTreePath.endsWith("/") ? contextTreePath.slice(0, -1) : contextTreePath;
  if (!filePath.startsWith(`${root}/`)) return null;
  const rel = filePath.slice(root.length + 1);
  return rel.length > 0 ? rel : null;
}

/** Local Context Tree repo mapping available to the tool-call processor. */
export type ContextTreeBinding = { path: string | null; repoUrl: string | null; branch?: string | null };

function toolFileRef(toolName: string, input: unknown, contextTree?: ContextTreeBinding): ToolFileRef | null {
  if (!TREE_READ_TOOL_NAMES.has(toolName) && !TREE_WRITE_TOOL_NAMES.has(toolName)) return null;
  const filePath = readFilePathArg(input);
  if (filePath === null) return null;
  // Containment (canonical, symlink-safe) or repo identity (tree PR
  // worktrees — any checkout whose origin remote IS the Context Tree repo).
  // Relative paths keep the fail-safe null mapping — canonicalizing them
  // would resolve against the daemon's cwd and risk mis-attribution.
  const repoRelativePath =
    contextTree && isAbsolute(filePath)
      ? resolveContextTreeRelativePath(filePath, {
          contextTreePath: contextTree.path,
          contextTreeRepoUrl: contextTree.repoUrl,
        })
      : null;
  return {
    origin: "tool_arg",
    localPath: filePath,
    pathKind: "file",
    ...(contextTree?.repoUrl && repoRelativePath !== null
      ? {
          repoUrl: contextTree.repoUrl,
          ...(contextTree.branch ? { repoBranch: contextTree.branch } : {}),
          repoRelativePath,
        }
      : {}),
  };
}

function statIsFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/** Extract a string `path` argument from a search tool_use input, if present. */
function searchPathArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" ? p : null;
}

/**
 * Directory-level ref for a Grep/Glob call whose explicit `path` argument
 * targets the Context Tree. Calls without a `path` argument default to the
 * session cwd (the workspace root, not the tree) and carry no ref — fail-safe
 * under-counting over mis-attribution, same stance as `toolFileRef`.
 */
function searchToolFileRef(
  toolName: string,
  input: unknown,
  contextTree: ContextTreeBinding | undefined,
  cwd: string | null | undefined,
): ToolFileRef | null {
  if (!TREE_SEARCH_TOOL_NAMES.has(toolName)) return null;
  const rawPath = searchPathArg(input);
  if (rawPath === null) return null;
  if (!isAbsolute(rawPath) && !cwd) return null;
  const absolutePath = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd ?? "", rawPath);
  const repoRelativePath = contextTree
    ? resolveContextTreeRelativePath(absolutePath, {
        contextTreePath: contextTree.path,
        contextTreeRepoUrl: contextTree.repoUrl,
      })
    : null;
  return {
    origin: "tool_arg",
    localPath: absolutePath,
    // Grep accepts a file as its search root; everything else is a directory.
    pathKind: repoRelativePath === "/" ? "repo" : statIsFile(absolutePath) ? "file" : "directory",
    ...(contextTree?.repoUrl && repoRelativePath !== null
      ? {
          repoUrl: contextTree.repoUrl,
          ...(contextTree.branch ? { repoBranch: contextTree.branch } : {}),
          repoRelativePath,
        }
      : {}),
  };
}

function readCommandArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function toolFileRefs(
  toolName: string,
  input: unknown,
  contextTree: ContextTreeBinding | undefined,
  cwd: string | null | undefined,
): ToolFileRef[] {
  const directRef = toolFileRef(toolName, input, contextTree);
  if (directRef) return [directRef];
  const searchRef = searchToolFileRef(toolName, input, contextTree, cwd);
  if (searchRef) return [searchRef];
  if (toolName !== "Bash" || !cwd) return [];
  const command = readCommandArg(input);
  if (command === null) return [];
  return toolFileRefsFromShellCommand({
    command,
    cwd,
    contextTreePath: contextTree?.path ?? null,
    contextTreeRepoUrl: contextTree?.repoUrl ?? null,
    contextTreeBranch: contextTree?.branch ?? null,
  });
}

/**
 * Pair `tool_use` (assistant) with `tool_result` (user) blocks and emit a
 * `tool_call` event per pair. Unpaired entries are flushed as `status: "pending"`.
 *
 * Successful single-file read/write tools carry generic `toolFileRefs`
 * evidence. When the local path can be mapped to a known repo checkout, the ref
 * includes repo evidence. The server derives Context Tree IO from that evidence
 * and the actual runtime/tool.
 */
export type ToolCallProcessor = {
  onMessage(message: unknown): void;
  flush(): void;
};

export function createToolCallProcessor(
  emit: (event: SessionEvent) => void,
  contextTree?: ContextTreeBinding,
  options: { cwd?: string | null; gitWriteTracker?: ContextTreeGitWriteTracker } = {},
): ToolCallProcessor {
  type Pending = { toolUseId: string; name: string; args: unknown; startedAt: number };
  const pending = new Map<string, Pending>();

  function pairResult(block: ToolResultBlock): void {
    const entry = pending.get(block.tool_use_id);
    if (!entry) return;
    const status: "ok" | "error" = block.is_error === true ? "error" : "ok";
    const durationMs = Date.now() - entry.startedAt;
    const previewRaw = extractToolResultText(block.content);
    const resultPreview = previewRaw.length > 0 ? previewRaw.slice(0, TOOL_RESULT_PREVIEW_LIMIT) : undefined;
    if (status === "error") options.gitWriteTracker?.captureBaseline();
    const refs = status === "ok" ? toolFileRefs(entry.name, entry.args, contextTree, options.cwd) : [];
    const gitStatusRefs =
      status === "ok"
        ? (options.gitWriteTracker?.refsForSuccessfulToolCall({
            toolName: entry.name,
            toolUseId: entry.toolUseId,
            existingRefs: refs,
          }) ?? [])
        : [];
    const allRefs = [...refs, ...gitStatusRefs];

    emit({
      kind: "tool_call",
      payload: {
        toolUseId: entry.toolUseId,
        name: entry.name,
        args: entry.args,
        status,
        durationMs,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(allRefs.length > 0 ? { toolFileRefs: allRefs } : {}),
      },
    });

    pending.delete(block.tool_use_id);
  }

  return {
    onMessage(message: unknown): void {
      if (!message || typeof message !== "object") return;
      const type = (message as { type?: unknown }).type;
      if (type === "assistant") {
        for (const block of extractContentBlocks(message)) {
          if (isToolUseBlock(block)) {
            options.gitWriteTracker?.captureBaseline();
            pending.set(block.id, {
              toolUseId: block.id,
              name: block.name,
              args: block.input,
              startedAt: Date.now(),
            });
            // Emit a pending row the moment the tool_use appears — otherwise
            // long-running tools (Bash sleep, network fetches) show nothing
            // live and the chat jumps straight from silence to `used <tool>`
            // after completion. Frontend dedupes by toolUseId against the
            // final ok/error emit (see filterEventsForTimeline).
            emit({
              kind: "tool_call",
              payload: {
                toolUseId: block.id,
                name: block.name,
                args: block.input,
                status: "pending",
              },
            });
          } else if (isTextBlock(block)) {
            const text = block.text.trim();
            if (text.length === 0) continue;
            // Chunk so the FULL assistant text is preserved across one or more
            // events — the durable troubleshooting record now that the
            // per-turn final-text chat mirror is retired.
            for (const chunk of chunkAssistantText(text)) {
              emit({ kind: "assistant_text", payload: { text: chunk } });
            }
          } else if (isThinkingBlock(block)) {
            emit({ kind: "thinking", payload: {} });
          }
        }
      } else if (type === "user") {
        for (const block of extractContentBlocks(message)) {
          if (isToolResultBlock(block)) pairResult(block);
        }
      }
    },
    flush(): void {
      // `pending` rows were already emitted up-front when each tool_use
      // arrived, so flush is now just a bookkeeping reset — no second emit.
      // Unpaired entries stay visible as "pending" in the UI until the next
      // turn_end collapses them with the rest of the abandoned turn.
      pending.clear();
    },
  };
}

/**
 * Map a payload's MCP server list to the SDK's record type. Handles all three
 * transports (stdio/http/sse) defined in the M1 schema.
 */
export function mapMcpServers(payload: AgentRuntimeConfigPayload): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const s of payload.mcpServers) {
    if (s.transport === "stdio") {
      out[s.name] = { type: "stdio", command: s.command, args: s.args };
    } else if (s.transport === "http") {
      out[s.name] = { type: "http", url: s.url, headers: s.headers };
    } else {
      out[s.name] = { type: "sse", url: s.url, headers: s.headers };
    }
  }
  return out;
}

/** Payload-derived slice of the Claude Code SDK query options. */
export type ClaudeQueryConfigOptions = {
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  effort?: EffortLevel;
  systemPrompt?: {
    type: "preset";
    preset: "claude_code";
    append?: string;
  };
};

/**
 * Build the config-derived slice of the SDK query options (model, MCP
 * servers, reasoning effort). Kept pure and exported so these mappings are
 * unit-testable; the session-bound options (env, canUseTool, abortController,
 * sessionId/resume) stay inline in `buildQuery`.
 *
 * Per-agent prompt instructions, working-directory convention, and source-repo
 * list land in `<cwd>/AGENTS.md` (which `CLAUDE.md` symlinks to). Per-chat
 * Current Chat Context is appended through the SDK `systemPrompt` channel so
 * concurrent chats sharing one agent home cannot overwrite each other's
 * context in the shared briefing file.
 *
 * Reasoning effort: the claude variant's `""` is an inherit sentinel — when
 * set we omit the `effort` option so the SDK falls back to the operator's local
 * `~/.claude/settings.json` effortLevel (preserving pre-feature behavior). A
 * non-empty value is passed explicitly and overrides that local setting.
 */
export function buildClaudeQueryOptions(
  payload: AgentRuntimeConfigPayload | undefined,
  chatContext?: ChatContext,
): ClaudeQueryConfigOptions {
  const options: ClaudeQueryConfigOptions = {};
  if (payload?.model) options.model = payload.model;
  if (payload?.mcpServers.length) options.mcpServers = mapMcpServers(payload);
  if (payload?.kind === "claude-code" && payload.reasoningEffort) {
    options.effort = payload.reasoningEffort;
  }
  // The runtime output contract always rides along (it does not depend on
  // chatContext); the per-chat context block is appended after it when present.
  // Both live in `systemPrompt.append`, which the SDK places after the
  // `claude_code` base preset but at higher salience than the project CLAUDE.md.
  const append = [renderRuntimeOutputContract(), renderChatContextPrompt(chatContext)]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  if (append) {
    options.systemPrompt = {
      type: "preset",
      preset: "claude_code",
      append,
    };
  }
  return options;
}

/**
 * Decide whether a model swap can use `query.setModel()` (in-flight, ~0ms)
 * vs needing a `resume` restart (~5–10s cold start).
 *
 * "Same family" = model id share the `claude-<family>-<series>` prefix
 * (e.g. `claude-opus-4-5` ↔ `claude-opus-4-6` are same family; `claude-opus-*`
 * ↔ `claude-haiku-*` are not). The SDK's `setModel` handles within-family
 * swaps cleanly; cross-family ones should restart to avoid context-window
 * mismatches.
 */
export function isSameModelFamily(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const segA = a.split("-");
  const segB = b.split("-");
  // claude-<family>-<series>-<rev>
  if (segA.length < 3 || segB.length < 3) return false;
  return segA[0] === segB[0] && segA[1] === segB[1] && segA[2] === segB[2];
}

/**
 * Claude Code Handler — session-oriented handler using the Agent SDK.
 *
 * Each handler instance owns a single Claude session for one chat.
 * Uses streaming input (InputController) for mid-processing message injection
 * and session resume from disk for idle reclaim recovery.
 */
export const createClaudeCodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const runtimeProvider: RuntimeProvider = runtimeProviderSchema.safeParse(config.runtimeProvider).success
    ? runtimeProviderSchema.parse(config.runtimeProvider)
    : "claude-code";
  const providerTurnMaxRetries = maxProviderTurnRetryAttempts();
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  // Pre-resolved by registerBuiltinHandlers at process start. Undefined =
  // defer to the SDK's bundled native binary (see claude-executable.ts for
  // why we can't always rely on it).
  const claudeCodeExecutable =
    (config.claudeCodeExecutable as string | undefined) ?? resolveClaudeCodeExecutable().path;

  let cwd: string | null = null;
  let claudeSessionId: string | null = null;
  let currentQuery: Query | null = null;
  let activeProviderEnv: Record<string, string | undefined> | null = null;
  let inputController: InputController<PendingSdkInput> | null = null;
  let providerRetryBackoffAbort: AbortController | null = null;
  let consumerDone: Promise<void> | null = null;
  let retryCount = 0;
  let ctx: SessionContext | null = null;
  /** Snapshot of the runtime config the *current* sub-process was launched with. */
  let appliedConfigVersion = 0;
  let appliedModel = "";
  let appliedPayload: AgentRuntimeConfigPayload | null = null;
  /**
   * Briefing-staleness tracking for the active session (see
   * session-briefing-fingerprint.ts). `current` is the fingerprint of the
   * briefing on disk right now — refreshed wherever the briefing is
   * (re)written: start, resume, fresh-fallback, and the config hot-switch
   * restart. `delivered` is the fingerprint the most recently *delivered* turn
   * ran under (mirrored to the per-session file). A turn-starting user message
   * gets the one-time re-read notice exactly when `current` differs from
   * `delivered` — which covers cold resume, a session predating the mechanism
   * (`delivered` loads as null), AND a mid-session config hot-switch that
   * rewrote the briefing before the next message.
   */
  let currentBriefingFingerprint: string | null = null;
  let deliveredBriefingFingerprint: string | null = null;
  /**
   * Latest chat-context snapshot for the active session. Used to build the
   * session/resume system-prompt block injected via `systemPrompt.append`.
   * Cleared when the session ends or `start()` runs for a fresh session.
   */
  let chatContextForPrompt: ChatContext | undefined;
  const queuedInjectedMessages: QueuedInjectedMessage[] = [];
  const pendingAckMessages: PendingAckMessage[] = [];
  let injectDrainInProgress = false;
  let drainingInjectedMessage: QueuedInjectedMessage | null = null;
  let inputRecoveryReason: string | null = null;
  /**
   * Predeclared source repos the agent config declares at
   * `<agentHome>/source-repos/<localPath>/`. Pure declaration (`declaredSourceRepos`) —
   * the agent itself clones/refreshes them per its briefing protocol.
   * Surfaced in the briefing so the LLM knows the absolute paths and
   * upstream coordinates. NOT to be confused with on-demand worktrees the
   * agent creates under `<agentHome>/worktrees/<name>/` — those are
   * runtime-opaque (created and cleaned up by the agent, not by First Tree).
   */
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];
  /**
   * SDK inputs pushed into the active query that have not reached a terminal
   * turn boundary yet. Transient retry must replay the whole unclosed pushed
   * buffer, including a tail input the old query accepted into its controller
   * but crashed before the provider pulled. ACK eligibility is stricter and is
   * tracked separately by `PendingAckMessage.providerEntered`.
   */
  const unclosedSdkInputs: PendingSdkInput[] = [];

  function cancelProviderRetryBackoff(): void {
    providerRetryBackoffAbort?.abort();
    providerRetryBackoffAbort = null;
  }

  function providerRetryBackoffPending(): boolean {
    return providerRetryBackoffAbort !== null;
  }

  /**
   * Honor the shared provider retry delay while allowing suspend/shutdown to
   * interrupt the foreground retry chain immediately.
   */
  async function waitForProviderRetry(delayMs: number): Promise<boolean> {
    if (delayMs <= 0) return true;

    cancelProviderRetryBackoff();
    const backoffAbort = new AbortController();
    providerRetryBackoffAbort = backoffAbort;

    try {
      await new Promise<void>((resolveDelay) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          backoffAbort.signal.removeEventListener("abort", finish);
          resolveDelay();
        };
        const timer = setTimeout(finish, delayMs);
        backoffAbort.signal.addEventListener("abort", finish, { once: true });
        if (backoffAbort.signal.aborted) finish();
      });
      return !backoffAbort.signal.aborted;
    } finally {
      if (providerRetryBackoffAbort === backoffAbort) providerRetryBackoffAbort = null;
    }
  }

  function emitProviderTurnRetryEvent(
    sessionCtx: SessionContext,
    event: "provider_retry_scheduled" | "provider_retry_exhausted" | "provider_failure_terminal",
    classification: ProviderFailureClassification,
    decision: ProviderRetryDecision,
    messagePreview: string,
  ): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(
          buildProviderRetryEvent({
            event,
            provider: runtimeProvider,
            scope: "provider_turn",
            classification,
            decision,
            messagePreview,
          }),
        ),
      },
    });
  }

  function emitAutoResumeFailedTerminalEvent(input: {
    sessionCtx: SessionContext;
    classification: ProviderFailureClassification;
    replaySafety: ReplaySafety;
    providerMessagePreview: string;
    resumeMsg: string;
  }): void {
    const decision: ProviderRetryDecision = {
      action: "stop",
      reasonCode: "claude_auto_resume_failed",
      terminalKind: "exhausted",
      replaySafety: input.replaySafety,
      userSeverity: "error",
    };
    const messagePreview = `Auto-resume failed: ${input.resumeMsg}\nProvider failure: ${input.providerMessagePreview}`;
    input.sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(
          buildProviderRetryEvent({
            event: "provider_failure_terminal",
            provider: runtimeProvider,
            scope: "provider_turn",
            classification: input.classification,
            decision,
            messagePreview,
          }),
        ),
      },
    });
  }

  function formatAutoResumeFailedMessage(resumeMsg: string): string {
    return `Auto-resume failed: ${redactErrorPreview(resumeMsg, 800)}`;
  }

  function emitProviderTurnSettlementEvent(sessionCtx: SessionContext, settlement: ProviderAttemptSettlement): void {
    sessionCtx.emitEvent({
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(settlement.eventPayload),
      },
    });
  }

  function consumedReasonForProviderSettlement(
    settlement: ProviderAttemptSettlement,
  ): Parameters<typeof consumedErrorOutcome>[0] {
    const decision = settlement.decision;
    if (decision.action !== "stop") return settlement.classification.reasonCode;
    if (decision.terminalKind === "exhausted") return "provider_retry_exhausted";
    return decision.reasonCode;
  }

  function settleClaudeProviderFailure(failure: ClaudeProviderFailure): ProviderAttemptSettlement | null {
    const attempt = new ProviderAttempt({
      provider: runtimeProvider,
      scope: "provider_turn",
      source: "sdk",
      ...(failure.signal.replaySafety ? { replaySafety: failure.signal.replaySafety } : {}),
    });
    attempt.recordSignal(failure.signal);
    return attempt.settle({ attempt: retryCount + 1 });
  }

  async function toSDKUserMessage(
    message: SessionMessage,
    sessionCtx: SessionContext,
    sessionId: string,
  ): Promise<SDKUserMessage> {
    // Image messages — two supported shapes:
    //   1. imageRef: `{imageId, mimeType, filename, size}` — new path. Bytes
    //      live on local disk, fetched from the `attachments` store on delivery
    //      (see SessionManager.ensureImagesLocal).
    //   2. legacy inline: `{data, mimeType, filename, size}` — pre-refactor
    //      messages still pending at rollout time. Decode once and drop the
    //      temp path into the prompt.
    //
    // Either way we direct the model at a real file path because Claude Code's
    // native Read tool loads images as multimodal content blocks — the SDK
    // does not reliably forward `{ type: "image" }` blocks to the underlying
    // model.
    if (message.format === "file") {
      // Build the full attribution header (name · type · sent) once up front so
      // both branches emit the same `[From: …]` header as the default text path.
      const header = await sessionCtx.formatFromHeader(message);
      const prefix = header ? `${header}\n\n` : "";

      // Batched send (caption + N images in one message). Resolve every
      // imageId to a local path the Read tool can open; missing-byte cases
      // surface a per-attachment "not available on this device" placeholder
      // so the session keeps moving and a partial-delivery doesn't strand
      // the whole turn.
      if (isImageBatchRefContent(message.content)) {
        const caption = message.content.caption?.trim() ?? "";
        const lines: string[] = [];
        if (caption.length > 0) lines.push(caption);
        lines.push(
          message.content.attachments.length === 1
            ? "An image was shared in this chat. Please use the Read tool to read it, then respond based on what you see."
            : `${message.content.attachments.length} images were shared in this chat. Please use the Read tool to read each one, then respond based on what you see.`,
        );
        for (const att of message.content.attachments) {
          const imagePath = findImagePath(message.chatId, att.imageId, att.mimeType);
          if (imagePath) {
            lines.push(`\nFilename: ${att.filename}\nPath: ${imagePath}`);
          } else {
            lines.push(`\n[Image "${att.filename}" not available on this device]`);
          }
        }
        // A mixed send (images + documents) also carries document/file refs in
        // metadata.attachments — append their on-disk paths so the agent sees
        // both. Null when the message has no documents (the common image case).
        const docNote = renderDocumentAttachmentsForLLM(message);
        if (docNote) lines.push(`\n${docNote}`);
        return {
          type: "user",
          message: { role: "user", content: `${prefix}${lines.join("\n")}` },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }

      if (isImageRefContent(message.content)) {
        const { imageId, mimeType, filename } = message.content;
        const imagePath = findImagePath(message.chatId, imageId, mimeType);
        if (imagePath) {
          const text = `${prefix}An image was shared in this chat. Please use the Read tool to read it, then respond based on what you see.\n\nFilename: ${filename}\nPath: ${imagePath}`;
          return {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        }
        // Bytes never reached this client (the attachments fetch failed or
        // the ref points at a deleted/expired attachment). Treat as the
        // "not available on this device" case so the session keeps moving.
        const fallbackText = `[Image "${filename}" not available on this device]`;
        return {
          type: "user",
          message: { role: "user", content: `${prefix}${fallbackText}` },
          parent_tool_use_id: null,
          session_id: sessionId,
        };
      }

      if (isLegacyImageFileContent(message.content)) {
        const { filename } = message.content;
        try {
          const imagePath = await writeLegacyImageToTempFile(message.content, message.chatId);
          const text = `${prefix}An image was shared in this chat. Please use the Read tool to read it, then respond based on what you see.\n\nFilename: ${filename}\nPath: ${imagePath}`;
          return {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        } catch (err) {
          // Avoid leaking raw fs error messages (they contain absolute paths).
          const fallbackText = `[Image attachment "${filename}" failed to materialise]`;
          ctx?.log(`Failed to write image to temp file: ${err instanceof Error ? err.message : String(err)}`);
          return {
            type: "user",
            message: { role: "user", content: `${prefix}${fallbackText}` },
            parent_tool_use_id: null,
            session_id: sessionId,
          };
        }
      }
    }

    // Default text content — sender attribution lives in the runtime so every
    // handler frames `[From: ...]` the same way. See runtime/agent-io.ts.
    return {
      type: "user",
      message: { role: "user", content: await sessionCtx.formatInboundContent(message) },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  /**
   * Prepend the one-time "your instructions changed — re-read CLAUDE.md" notice
   * to a resumed turn's user message, so the agent reads it before acting on
   * the message. Only the text content shape is handled (every
   * `toSDKUserMessage` branch returns a string `content`); anything else is
   * returned untouched.
   */
  function prependBriefingUpdateNotice(sdkMsg: SDKUserMessage, claudeMdPath: string): SDKUserMessage {
    const { content } = sdkMsg.message;
    if (typeof content !== "string") return sdkMsg;
    return {
      ...sdkMsg,
      message: { ...sdkMsg.message, content: `${buildBriefingUpdateNotice(claudeMdPath)}\n\n${content}` },
    };
  }

  /**
   * The single chokepoint for delivering a turn-starting user message to the
   * SDK input controller. Used by start / resume / fresh-fallback / the inject
   * drain so every path shares one briefing-staleness contract:
   *
   *   - prepend the one-time re-read notice when the on-disk briefing
   *     (`currentBriefingFingerprint`) differs from what the last delivered
   *     turn ran under (`deliveredBriefingFingerprint`);
   *   - advance the baseline ONLY after the input is in the replay buffer, so a
   *     synchronous `buildQuery()` failure before this point leaves the notice
   *     pending for the retry rather than recording it as already shown.
   */
  function deliverUserMessage(
    sdkMsg: SDKUserMessage,
    message: SessionMessage,
    token: DeliveryToken,
    sessionId: string,
    sessionCtx: SessionContext,
  ): void {
    const briefingChanged =
      currentBriefingFingerprint !== null && deliveredBriefingFingerprint !== currentBriefingFingerprint;
    let outgoing = sdkMsg;
    if (briefingChanged && cwd) {
      sessionCtx.log(`Briefing changed since last delivered turn — prepending re-read notice (${sessionId})`);
      outgoing = prependBriefingUpdateNotice(sdkMsg, join(cwd, "CLAUDE.md"));
    }
    pushPendingSdkInput(createPendingSdkInput(outgoing, message, token));
    // The input is now buffered for replay; advancing the baseline here ties it
    // to delivery actually reaching the controller.
    if (briefingChanged) {
      deliveredBriefingFingerprint = currentBriefingFingerprint;
      if (cwd && currentBriefingFingerprint) {
        writeSessionBriefingFingerprint(cwd, sessionId, currentBriefingFingerprint);
      }
    }
  }

  /**
   * Build env for the child Claude Code process.
   *
   * When the client runtime runs inside a Claude Code session (nested env),
   * process.env contains internal markers (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT,
   * CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, npm_lifecycle_script) that cause the
   * child to enable Agent Teams infrastructure and use wrong init paths,
   * resulting in ~90s cold start vs ~17s standalone. Strip these here (Claude
   * Code specific) then let the runtime layer add the First Tree envelope via
   * `ctx.buildAgentEnv` so all handlers expose the same vars uniformly.
   */
  function buildEnv(sessionCtx: SessionContext): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };

    // Parent session markers — not needed by the child
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete env.npm_lifecycle_script;

    // Step 6: layer in user-configured env (sensitive already decrypted at
    // service level; see config-service.getDecrypted()). User vars come
    // BEFORE First Tree-internal vars so the latter wins on collision.
    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
    if (payload) {
      for (const e of payload.env) env[e.key] = e.value;
    }

    // Child processes receive the member access JWT as FIRST_TREE_ACCESS_TOKEN
    // and pair it with X-Agent-Id (sent by the SDK automatically) to act as
    // the current agent. Obtaining the token at buildEnv-time means the child
    // sees the JWT valid at its spawn moment; long-lived runtimes should
    // re-spawn after refresh, or re-read the env on their own cadence.
    return sessionCtx.buildAgentEnv(env);
  }

  /** Create query and input controller, then start consumer loop. */
  function spawnQuery(
    sessionId: string,
    sessionCtx: SessionContext,
    resume?: string,
    providerEnv?: Record<string, string | undefined>,
  ): void {
    // The latest chat-context and source-repo snapshot live in module-scoped
    // caches (`chatContextForPrompt`, `sourceReposForPrompt`) which the
    // handler refreshes in start/resume BEFORE this call. `maybeSwitchConfig`
    // additionally rewrites the briefing before invoking `buildQuery` so a
    // mid-session config swap surfaces in the freshly read CLAUDE.md.
    buildQuery(sessionId, sessionCtx, resume, providerEnv);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
  }

  /**
   * Single helper for "turn closed → finish the provider-entered inbox
   * prefix AND drop settled inputs from the replay buffer". The two
   * operations are paired everywhere a turn finishes (success /
   * sniff-permanent / forward-error / no-result / non-success subtype /
   * MAX_RETRIES / respawn-fail) — folding them into one call keeps the
   * invariant "input replay lives only as long as the turn still might need a
   * replay" enforced in one place. Use the raw
   * `finishTurn(message, ...)` directly for per-message terminal
   * failures (e.g. inject's `toSDKUserMessage` catch) where the semantics is
   * "commit this single inbox message, NOT close the active SDK turn".
   */
  function pendingProviderEnteredPrefix(): PendingAckMessage[] {
    const prefix: PendingAckMessage[] = [];
    for (const pending of pendingAckMessages) {
      if (!pending.providerEntered) break;
      prefix.push(pending);
    }
    return prefix;
  }

  function isCurrentPendingPrefix(batch: readonly PendingAckMessage[]): boolean {
    return batch.every((pending, index) => pendingAckMessages[index] === pending);
  }

  async function ackTurnClose(
    status: "success" | "error",
    reason: Parameters<typeof consumedErrorOutcome>[0] = "provider_clean_error",
    providerEnteredPrefix: readonly PendingAckMessage[] = pendingProviderEnteredPrefix(),
  ): Promise<void> {
    const fallbackErrorPending =
      status === "error" && providerEnteredPrefix.length === 0 ? pendingAckMessages[0] : undefined;
    const batch =
      providerEnteredPrefix.length > 0
        ? [...providerEnteredPrefix]
        : fallbackErrorPending
          ? [fallbackErrorPending]
          : [];
    let settledBatch: PendingAckMessage[] = [];
    if (batch.length > 0 && isCurrentPendingPrefix(batch)) {
      pendingAckMessages.splice(0, batch.length);
      const messages = batch.map((pending) => pending.message);
      const tail = batch[batch.length - 1];
      const outcome = status === "success" ? { status, terminal: true } : consumedErrorOutcome(reason);
      await tail?.token.complete(messages, outcome);
      settledBatch = batch;
    }
    if (settledBatch.length > 0) {
      const settled = new Set(settledBatch);
      for (let index = unclosedSdkInputs.length - 1; index >= 0; index--) {
        const input = unclosedSdkInputs[index];
        if (input?.pendingAck && settled.has(input.pendingAck)) unclosedSdkInputs.splice(index, 1);
      }
    }
  }

  function createPendingSdkInput(
    sdkMessage: SDKUserMessage,
    message: SessionMessage,
    token: DeliveryToken,
  ): PendingSdkInput {
    return {
      sdkMessage,
      pendingAck: { message, token, providerEntered: false },
    };
  }

  function pushPendingSdkInput(input: PendingSdkInput): void {
    if (input.pendingAck) pendingAckMessages.push(input.pendingAck);
    unclosedSdkInputs.push(input);
    inputController?.push(input);
  }

  function markProviderEntered(input: PendingSdkInput): void {
    const pending = input.pendingAck;
    if (!pending || pending.providerEntered) return;
    pending.providerEntered = true;
    pending.token.processingStarted(pending.message);
  }

  async function* providerPromptInputs(inputs: AsyncIterable<PendingSdkInput>): AsyncIterable<SDKUserMessage> {
    for await (const input of inputs) {
      markProviderEntered(input);
      yield input.sdkMessage;
    }
  }

  function retryInjectedItem(item: QueuedInjectedMessage, reason: string): void {
    item.recoveryReason = reason;
    if (item.recoveryRetried) return;
    item.recoveryRetried = true;
    item.token.retry(item.message, reason);
  }

  function recoverIfInputClosed(item: QueuedInjectedMessage): boolean {
    const reason = item.recoveryReason ?? inputRecoveryReason;
    if (!reason) return false;
    retryInjectedItem(item, reason);
    return true;
  }

  async function pushInjectedMessage(
    item: QueuedInjectedMessage,
    sessionCtx: SessionContext,
    sessionId: string,
  ): Promise<void> {
    const { message, token } = item;
    if (recoverIfInputClosed(item)) return;
    try {
      await maybeSwitchConfig(sessionCtx);
    } catch (err) {
      sessionCtx.log(`maybeSwitchConfig errored: ${err instanceof Error ? err.message : String(err)}`);
      // Path B may already have retired the provider-retry consumer before a
      // fallible config-restart step fails. Do not continue into an orphaned
      // input controller. Retire the provider transport before returning the
      // provider-entered prefix and unentered tail to runtime recovery so a
      // fresh handler cannot overlap the abandoned native process.
      retireProviderTransport();
      retryBufferedMessages("claude_config_restart_failed_recovery");
      failFatalSessionForRecovery(sessionCtx, "claude_config_restart_failed");
      return;
    }
    if (recoverIfInputClosed(item)) return;

    try {
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
      if (recoverIfInputClosed(item)) return;
      // Same chokepoint as start/resume: if a config hot-switch (or anything
      // else) rewrote the briefing since the last delivered turn, this is where
      // the re-read notice is attached before the message enters the buffer.
      deliverUserMessage(sdkMsg, message, token, sessionId, sessionCtx);
    } catch (err) {
      if (recoverIfInputClosed(item)) return;
      sessionCtx.log(`toSDKUserMessage errored: ${err instanceof Error ? err.message : String(err)}`);
      // The SDK has not seen this input yet, so there is no durable terminal
      // evidence. Keep it recoverable instead of ACKing through `complete`.
      token.retry(message, "claude_inject_format_failed");
    }
  }

  function scheduleInjectedMessagesDrain(sessionCtx: SessionContext, sessionId: string): void {
    if (!inputController || injectDrainInProgress) return;
    void (async () => {
      injectDrainInProgress = true;
      try {
        while (
          queuedInjectedMessages.length > 0 &&
          inputController &&
          ctx === sessionCtx &&
          claudeSessionId === sessionId
        ) {
          const queued = queuedInjectedMessages.shift();
          if (!queued) continue;
          drainingInjectedMessage = queued;
          try {
            await pushInjectedMessage(queued, sessionCtx, sessionId);
          } catch (err) {
            sessionCtx.log(`inject drain failed: ${err instanceof Error ? err.message : String(err)}`);
            retryInjectedItem(queued, "claude_inject_drain_failed");
          } finally {
            if (drainingInjectedMessage === queued) drainingInjectedMessage = null;
          }
        }
      } finally {
        injectDrainInProgress = false;
        if (queuedInjectedMessages.length > 0 && inputController && ctx && claudeSessionId) {
          scheduleInjectedMessagesDrain(ctx, claudeSessionId);
        }
      }
    })();
  }

  function retryBufferedMessages(reason: string): void {
    inputRecoveryReason = reason;
    unclosedSdkInputs.length = 0;
    const pending = pendingAckMessages.splice(0);
    const drainingIsPending =
      drainingInjectedMessage !== null &&
      pending.some(
        (pendingItem) =>
          pendingItem.message === drainingInjectedMessage?.message &&
          pendingItem.token === drainingInjectedMessage.token,
      );
    if (drainingInjectedMessage && !drainingIsPending) retryInjectedItem(drainingInjectedMessage, reason);
    const queued = queuedInjectedMessages.splice(0);
    for (const item of queued) {
      retryInjectedItem(item, reason);
    }
    for (const item of pending) {
      item.token.retry(item.message, reason);
    }
  }

  function failFatalSessionForRecovery(sessionCtx: SessionContext, reason: string): void {
    sessionCtx.failSessionForRecovery?.(reason, claudeSessionId ?? undefined);
  }

  function retireProviderTransport(): void {
    cancelProviderRetryBackoff();

    const controller = inputController;
    inputController = null;
    try {
      controller?.end();
    } catch {
      // best-effort transport cleanup
    }

    const query = currentQuery;
    currentQuery = null;
    try {
      query?.close();
    } catch {
      // best-effort transport cleanup
    }

    activeProviderEnv = null;
  }

  /**
   * Rebuild the SDK query in resume mode AND re-push every input already handed
   * to the previous query's controller for the still-unclosed turn, preserving
   * coalesced-input order. The
   * caller (the outer consumer loop's catch block) keeps owning the
   * for-await, so we deliberately do NOT start a new consumer here —
   * spawning one would create two parallel loops both consuming the
   * same `currentQuery` reference and both racing their own
   * `retryCount` counter (under persistent failure, that fans out into
   * unbounded recursion). Configuration (`applied*`) is preserved
   * across the retry — only the SDK query is recycled.
   *
   * Stays synchronous — the converted SDK payloads are already held in
   * `unclosedSdkInputs`, so the retry path doesn't need to re-run
   * `toSDKUserMessage` (which is async and would shift the consumer-loop
   * timing). An empty replay buffer is possible for an admin-triggered resume
   * with no user input; in that case the rebuilt query waits for the next
   * input normally.
   */
  function respawnQuery(sessionId: string, sessionCtx: SessionContext): void {
    buildQuery(sessionId, sessionCtx, sessionId, activeProviderEnv ?? buildEnv(sessionCtx));
    const replay = unclosedSdkInputs.slice();
    for (const input of replay) {
      inputController?.push(input);
    }
  }

  /**
   * Snapshot the runtime config the current sub-process was launched with.
   * Callers invoke this after `buildQuery` succeeds so a failed build never
   * records a payload as "applied".
   */
  function recordAppliedPayload(sessionCtx: SessionContext): void {
    const cached = agentConfigCache?.get(sessionCtx.agent.agentId);
    appliedConfigVersion = cached?.version ?? 0;
    appliedModel = cached?.payload?.model ?? "";
    appliedPayload = cached?.payload ?? null;
  }

  function buildQuery(
    sessionId: string,
    sessionCtx: SessionContext,
    resume?: string,
    providerEnv?: Record<string, string | undefined>,
  ): void {
    // Construct the replacement locally so a synchronous SDK constructor
    // failure cannot leave the handler pointing at an orphan controller while
    // the previous query still owns the unsettled turn.
    const nextInputController = new InputController<PendingSdkInput>();
    const nextAbortController = new AbortController();

    // Step 6: M1 hard-codes bypassPermissions per PRD §5.1.6 (permission mode
    // is intentionally not exposed to admins).
    const permissionMode: PermissionMode = "bypassPermissions";

    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;

    const childEnv = providerEnv ?? buildEnv(sessionCtx);

    const nextQuery = claudeQuery({
      prompt: providerPromptInputs(nextInputController.iterable),
      options: {
        sessionId: resume ? undefined : sessionId,
        resume,
        cwd: cwd ?? undefined,
        persistSession: true,
        abortController: nextAbortController,
        permissionMode,
        allowDangerouslySkipPermissions: true,
        // SDK 0.2.84 defaults to isolation mode — no filesystem settings are
        // read. We opt into both `user` and `project`:
        //   - `project` loads the workspace CLAUDE.md (symlinked to AGENTS.md
        //     written by `writeAgentBriefing`). That shared briefing carries
        //     stable agent-level content: identity, prompt.append,
        //     working-dir convention, source-repo list, operating
        //     instructions, domain map, and the First Tree Agent Runtime block.
        //     Per-chat Current Chat Context is appended below through the SDK
        //     `systemPrompt` channel so sibling chats do not race on one file.
        //   - `user` inherits the operator's local `~/.claude/settings.json`
        //     so their Claude Code customizations (thinking mode, effortLevel,
        //     outputStyle, statusLine, plugins, skills, hooks, MCP servers)
        //     carry over to agent sessions on their machine. Server-managed
        //     fields (model, env, permissionMode, and the First Tree
        //     `mcpServers` list) still win because they are passed as
        //     explicit SDK options below, which layer on top of settings.
        settingSources: ["user", "project"],
        env: childEnv,
        // AskUserQuestion is not supported in First Tree — agents resolve
        // ask-a-human inline. Disable the tool at the SDK level so it never
        // surfaces in a session.
        disallowedTools: ["AskUserQuestion"],
        ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
        // model / mcpServers / effort — the config-derived slice. `effort: ""`
        // (inherit) is omitted so the SDK uses the local effortLevel.
        ...buildClaudeQueryOptions(payload, chatContextForPrompt),
      },
    });

    inputRecoveryReason = null;
    inputController = nextInputController;
    currentQuery = nextQuery;
    activeProviderEnv = childEnv;
  }

  /**
   * Step 6 hot-switch (Path A vs Path B). Returns true if a restart was
   * required and performed; false if it was an in-flight mutator (or no-op).
   */
  async function maybeSwitchConfig(sessionCtx: SessionContext): Promise<boolean> {
    if (!agentConfigCache || !claudeSessionId || !currentQuery) return false;
    const cached = agentConfigCache.get(sessionCtx.agent.agentId);
    if (!cached || cached.version === appliedConfigVersion) return false;

    const newPayload = cached.payload;
    const onlyModelChanged =
      appliedPayload !== null &&
      JSON.stringify({ ...appliedPayload, model: "" }) === JSON.stringify({ ...newPayload, model: "" }) &&
      appliedPayload.model !== newPayload.model;

    // Path A: same-family model swap → in-flight setModel.
    if (onlyModelChanged && isSameModelFamily(appliedModel, newPayload.model) && !providerRetryBackoffPending()) {
      try {
        await currentQuery.setModel(newPayload.model);
        sessionCtx.log(
          `[configHotSwitch] path=in-flight from=${appliedModel} to=${newPayload.model} version=${cached.version}`,
        );
        appliedModel = newPayload.model;
        appliedConfigVersion = cached.version;
        appliedPayload = newPayload;
        return false;
      } catch (err) {
        sessionCtx.log(`setModel failed, falling back to restart: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Path B: restart with resume — pick up new options and replay context.
    // Rebuild the query AND start a fresh consumer loop: the existing loop is
    // still iterating the OLD query and will exit once `oldQuery.close()`
    // drains it, so the new query would otherwise have no reader.
    sessionCtx.log(`[configHotSwitch] path=restart fromVersion=${appliedConfigVersion} toVersion=${cached.version}`);
    // Path B takes ownership of the unsettled turn. Retire an old consumer
    // that may be waiting in provider retry backoff before any async restart
    // preparation can yield; otherwise its timer could later respawn another
    // query alongside the config-switch consumer.
    cancelProviderRetryBackoff();
    // Rewrite AGENTS.md (CLAUDE.md symlink) with the new payload so the
    // restarted SDK Query — which reads CLAUDE.md via `settingSources:
    // ["project"]` on construction — picks up the new prompt.append. The
    // briefing is now the single channel; without this rewrite the swap
    // would update model/mcp/effort but silently leave the per-agent prompt
    // at the old version until the next session restart.
    const providerEnv = buildEnv(sessionCtx);
    if (cwd) {
      // A resource skill bound mid-session (config version bumped, model
      // unchanged) reaches the active session on this restart path. Materialize
      // it BEFORE rewriting the briefing so the "## Team Skills" entries the
      // briefing lists point at real SKILL.md files on disk — without this the
      // restarted turn sees the skill named but no file to load (the reused /
      // already-running agent bug). Guard on a genuine version increase so a
      // transient empty fallback config (swallowed refresh failure) can't prune
      // skills the running turn is about to load.
      if (cached.version > appliedConfigVersion) {
        await materializeResourceSkills(cwd, newPayload, sessionCtx);
      }
      const switchedBriefing = currentBriefing(sessionCtx, cwd, newPayload);
      writeAgentBriefing(cwd, switchedBriefing);
      // Refresh the on-disk briefing fingerprint so the NEXT delivered message
      // (drained right after this restart in pushInjectedMessage) sees the
      // change and carries the re-read notice. `delivered` is intentionally
      // left untouched — the transcript still reflects the pre-switch briefing.
      currentBriefingFingerprint = computeBriefingFingerprint(switchedBriefing);
    }
    const sid = claudeSessionId;
    const oldQuery = currentQuery;
    buildQuery(sid, sessionCtx, sid, providerEnv);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
    try {
      oldQuery.close();
    } catch {
      // ignore close errors — best-effort cleanup
    }
    return true;
  }

  async function consumeOutput(sessionCtx: SessionContext): Promise<void> {
    let turnHadUserVisibleOutput = false;
    const toolCallProcessor = createToolCallProcessor(
      (event) => {
        if (eventMakesReplayUnsafe(event)) turnHadUserVisibleOutput = true;
        sessionCtx.emitEvent(event);
      },
      {
        path: contextTreePath,
        repoUrl: contextTreeRepoUrl,
        branch: contextTreeBranch,
      },
      {
        cwd,
        gitWriteTracker: createContextTreeGitWriteTracker({
          contextTreePath,
          contextTreeRepoUrl,
          contextTreeBranch,
          log: (message) => sessionCtx.log(message),
        }),
      },
    );
    // Auth-failure hint emission flag. Set when we detect a typed
    // `authentication_failed` on assistant / auth_status messages. Consulted
    // in the result-error branch so we don't double-emit (once as a hint,
    // once as the raw SDK error). Two scopes share this:
    //   1. Within a single turn: per-turn reset on `result` boundary so the
    //      next turn within the SAME query (bg-agent multi-turn mode) starts
    //      fresh.
    //   2. Across retries (outer catch path that hands off to
    //      `handler.resume()`): NOT reset. An auth failure won't self-heal,
    //      so the resumed session typically hits the same error — without
    //      persistence the user would see two identical hint lines in the
    //      timeline.
    // Hoisted out of the try block so the outer catch's reentry preserves it
    // across the resume boundary.
    let authHintEmitted = false;
    // A typed auth signal whose hint is deferred until the result reveals
    // whether it is a genuine credential failure or a network-egress 403
    // ("Request not allowed") that only looks like auth. Held across the
    // result boundary; flushed (emitted) for genuine auth, dropped for egress.
    let pendingAuthHint: string | null = null;
    let pendingAssistantProviderFailure: ClaudeProviderFailure | null = null;
    const currentTurnReplaySafety = (): ReplaySafety => (turnHadUserVisibleOutput ? "user_visible" : "pre_visible");
    const resetTurnReplaySafety = (): void => {
      turnHadUserVisibleOutput = false;
    };
    try {
      queryLoop: while (true) {
        if (!currentQuery) return;

        try {
          // `modelUsage` is cumulative only within one concrete Query/native
          // process. Capture both together so a config hot-switch can start a
          // new consumer without sharing or clearing the old consumer's
          // accounting baseline while it drains.
          const query = currentQuery;
          const modelUsageBaseline = new Map<string, ClaudeModelUsageCounters>();
          for await (const message of query) {
            // Every message refreshes lastActivity to prevent idle timeout
            sessionCtx.recordProviderActivity();

            toolCallProcessor.onMessage(message);

            // Capture a typed auth failure, but DEFER the hint. A typed
            // `authentication_failed` can be the visible face of a network-egress
            // 403 ("Request not allowed") whose detail only arrives in the later
            // result; emitting "run claude auth login" now would mislead before
            // the result can reveal the true cause. Decide at result settlement
            // (or stream end). If the raw signal already shows egress (the
            // auth_status path carries the message text), suppress it outright.
            // The SDK's auth state lives in claude's own credential store — we
            // only translate the surface error, we don't manage tokens.
            const authFailure = detectClaudeAuthFailure(message);
            if (authFailure && !authHintEmitted && pendingAuthHint === null) {
              if (!isEgressForbiddenText(authFailure.rawMessage)) {
                pendingAuthHint = authFailure.rawMessage;
              }
            }
            const assistantProviderFailure = claudeFailureFromAssistantMessage(message);
            if (assistantProviderFailure) pendingAssistantProviderFailure = assistantProviderFailure;

            if (isResultMessage(message)) {
              const providerEnteredPrefix = pendingProviderEnteredPrefix();
              emitTokenUsageFromResult(message, sessionCtx, modelUsageBaseline);
              const providerFailure = mergeClaudeProviderFailures({
                resultFailure: claudeFailureFromSdkResult(message),
                assistantFailure: pendingAssistantProviderFailure,
                ...(turnHadUserVisibleOutput ? { replaySafety: "user_visible" as const } : {}),
              });
              pendingAssistantProviderFailure = null;
              if (providerFailure) {
                const settlement = settleClaudeProviderFailure(providerFailure);
                if (settlement) {
                  sessionCtx.log(
                    `Claude SDK provider failure (${settlement.classification.category}/${settlement.classification.reasonCode}): ${settlement.messagePreview}`,
                  );
                  if (settlement.decision.action === "retry") {
                    if (!claudeSessionId) {
                      throw new StreamApiTransientError(settlement.messagePreview);
                    }
                    retryCount = settlement.decision.attempt;
                    emitProviderTurnSettlementEvent(sessionCtx, settlement);
                    sessionCtx.log(`Attempting auto-resume (retry ${retryCount}/${providerTurnMaxRetries})`);
                    toolCallProcessor.flush();
                    if (!(await waitForProviderRetry(settlement.decision.delayMs))) {
                      sessionCtx.log("Auto-resume cancelled during provider retry backoff");
                      return;
                    }
                    try {
                      respawnQuery(claudeSessionId, sessionCtx);
                    } catch (resumeErr) {
                      const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
                      sessionCtx.log(`Auto-resume failed after Claude SDK provider failure: ${resumeMsg}`);
                      emitAutoResumeFailedTerminalEvent({
                        sessionCtx,
                        classification: settlement.classification,
                        replaySafety: settlement.decision.replaySafety,
                        providerMessagePreview: settlement.messagePreview,
                        resumeMsg,
                      });
                      sessionCtx.emitEvent({
                        kind: "error",
                        payload: { source: "runtime", message: formatAutoResumeFailedMessage(resumeMsg) },
                      });
                      sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
                      await ackTurnClose("error", "auto_resume_failed_notice_posted", providerEnteredPrefix);
                      retryBufferedMessages("claude_auto_resume_failed_tail_recovery");
                      failFatalSessionForRecovery(sessionCtx, "claude_auto_resume_failed");
                      return;
                    }
                    continue queryLoop;
                  }

                  emitProviderTurnSettlementEvent(sessionCtx, settlement);
                  // The result now reveals whether a deferred auth signal is a
                  // genuine credential failure or a network-egress 403 that only
                  // looks like auth. Flush the auth hint for the former; for
                  // egress, suppress it — the runtime notice posted at
                  // settlement carries the correct proxy-first guidance.
                  const settledEgressForbidden = isEgressForbiddenText(settlement.messagePreview);
                  if (pendingAuthHint !== null) {
                    if (!settledEgressForbidden && settlement.classification.category === "credential") {
                      authHintEmitted = true;
                      sessionCtx.emitEvent({
                        kind: "error",
                        payload: { source: "sdk", message: formatAuthHint("claude-code", pendingAuthHint) },
                      });
                    }
                    pendingAuthHint = null;
                  }
                  if (
                    !(
                      (authHintEmitted || settledEgressForbidden) &&
                      settlement.classification.category === "credential"
                    )
                  ) {
                    sessionCtx.emitEvent({
                      kind: "error",
                      payload: {
                        source: "sdk",
                        message: `Claude SDK provider failure (${settlement.classification.reasonCode}): ${settlement.messagePreview}`,
                      },
                    });
                  }
                  sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
                  retryCount = 0;
                  await ackTurnClose("error", consumedReasonForProviderSettlement(settlement), providerEnteredPrefix);
                  resetTurnReplaySafety();
                  continue;
                }
              }

              if (message.subtype === "success") {
                // Close out the turn. The result text is already captured as
                // `assistant_text` events; `forwardResult` no longer delivers
                // it to chat (final-text mirror retired) — it is the
                // turn-completion hook. We AWAIT it (rather than
                // fire-and-forget) so the turn_end emit is guaranteed to hit
                // the WebSocket before the for-await pulls the next turn's
                // first event. Otherwise a slow round-trip could let the
                // server assign a smaller seq to turn N+1's thinking/tool_call
                // than to turn N's turn_end — which would cause the frontend's
                // "latest turn_end" filter to retroactively hide turn N+1's
                // live events.
                if (message.result && sessionCtx.chatId) {
                  const resultText = message.result;
                  // Genuine success — reset retry budget for the next turn.
                  retryCount = 0;
                  try {
                    // Turn-completion hook. The agent's text is already
                    // captured as `assistant_text` events above; `forwardResult`
                    // no longer delivers it to chat (the per-turn final-text
                    // mirror is retired — see runtime/result-sink.ts), it just
                    // closes out the turn trigger.
                    await sessionCtx.forwardResult(resultText);
                    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
                    // Turn closed cleanly — drain in-flight inbox entries.
                    await ackTurnClose("success", "provider_clean_error", providerEnteredPrefix);
                    resetTurnReplaySafety();
                  } catch (err) {
                    const reason = err instanceof Error ? err.message : String(err);
                    sessionCtx.log(`Failed to forward result: ${reason}`);
                    const preview = resultText.slice(0, 1500);
                    const forwardErrMessage = `Result forward failed: ${reason}\n---\n${preview}`.slice(0, 2000);
                    sessionCtx.emitEvent({
                      kind: "error",
                      payload: { source: "runtime", message: forwardErrMessage },
                    });
                    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
                    // A failure in the completion hook is treated as terminal
                    // for this turn — ack so we don't loop on redelivery. The
                    // hook only closes the turn trigger now (the final-text
                    // mirror is retired, so there is no chat-delivery step to
                    // fail); a throw here is unexpected, but we still degrade
                    // gracefully. If recovery is needed the user can retry by
                    // sending a new message.
                    //
                    // Reset retryCount along with the success branch above:
                    // the SDK actually returned a clean `result` here (any
                    // failure is in our own turn-completion plumbing, not the
                    // model), so the next turn should not inherit the prior
                    // turn's transient-retry counter when an unrelated future
                    // stream error fires.
                    retryCount = 0;
                    await ackTurnClose("error", "forward_failed", providerEnteredPrefix);
                    resetTurnReplaySafety();
                  }
                } else {
                  // No result text to forward (edge case) — still close the turn.
                  // Same reset rationale as the forward-success branch above.
                  retryCount = 0;
                  sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
                  await ackTurnClose("success", "provider_clean_error", providerEnteredPrefix);
                  resetTurnReplaySafety();
                }
              }
              // Reset the auth-hint flag only on a SUCCESSFUL result. This
              // gives a clean slate for the next turn once auth is clearly
              // working, while suppressing a duplicate hint when the next
              // turn (or a retry — see flag declaration above) hits the same
              // unhealing auth failure. The user has already been told what
              // to do; repeating it adds noise without new information.
              if (message.subtype === "success") {
                authHintEmitted = false;
                // Drop any deferred auth signal too: a transient auth_status
                // warning followed by a successful turn must not leak a stale
                // auth-login hint at the next stream-end / turn boundary.
                pendingAuthHint = null;
              }
            }
          }
          // Stream ended cleanly without a result to settle a deferred auth
          // signal — emit the hint now (no result means no egress detail to
          // suppress it).
          if (pendingAuthHint !== null) {
            authHintEmitted = true;
            sessionCtx.emitEvent({
              kind: "error",
              payload: { source: "sdk", message: formatAuthHint("claude-code", pendingAuthHint) },
            });
            pendingAuthHint = null;
          }
          return;
        } catch (err) {
          // A deferred auth signal that never reached a result still deserves to
          // surface — the stream-error path below reports the crash, not the
          // auth cause.
          if (pendingAuthHint !== null) {
            authHintEmitted = true;
            sessionCtx.emitEvent({
              kind: "error",
              payload: { source: "sdk", message: formatAuthHint("claude-code", pendingAuthHint) },
            });
            pendingAuthHint = null;
          }
          // Process crash, OOM, or unexpected termination
          const errMsg = err instanceof Error ? err.message : String(err);
          sessionCtx.log(`Query error: ${errMsg}`);

          // Log additional diagnostic details when available
          if (err instanceof Error) {
            if (err.cause)
              sessionCtx.log(`  cause: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`);
            if ("exitCode" in err) sessionCtx.log(`  exitCode: ${(err as Record<string, unknown>).exitCode}`);
            if ("stderr" in err) sessionCtx.log(`  stderr: ${(err as Record<string, unknown>).stderr}`);
            if ("code" in err) sessionCtx.log(`  code: ${(err as Record<string, unknown>).code}`);
            if (err.stack) sessionCtx.log(`  stack: ${err.stack.split("\n").slice(1, 4).join(" | ")}`);
          }

          const classification = classifyProviderFailure(err, {
            provider: runtimeProvider,
            scope: "provider_turn",
            source: "stream",
          });
          const decision = decideProviderRetry({
            classification,
            scope: "provider_turn",
            attempt: retryCount + 1,
            replaySafety: currentTurnReplaySafety(),
          });

          if (decision.action !== "retry" || !claudeSessionId) {
            sessionCtx.log("Exhausted retries, session will be suspended");
            // Surface to the chat timeline so the user sees the failure and
            // doesn't think the agent silently stalled. The retry-exhausted
            // case in particular drops the turn entirely — no result will
            // be forwarded — so without an explicit error event the chat
            // would just go quiet.
            //
            // Wrap the emits so a broken `onSessionEvent` callback can't
            // short-circuit turn cleanup below.
            try {
              const preview = errMsg.slice(0, 800);
              const reason = claudeSessionId
                ? `Query failed after ${providerTurnMaxRetries} retries: ${preview}`
                : `Query failed and no resume id available: ${preview}`;
              emitProviderTurnRetryEvent(
                sessionCtx,
                decision.action === "stop" && decision.terminalKind === "exhausted"
                  ? "provider_retry_exhausted"
                  : "provider_failure_terminal",
                classification,
                decision.action === "stop"
                  ? decision
                  : {
                      action: "stop",
                      reasonCode: "claude_missing_resume_id",
                      terminalKind: "unsafe_replay",
                      replaySafety: "unknown",
                      userSeverity: "error",
                    },
                preview,
              );
              sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: reason } });
              sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
            } catch (emitErr) {
              sessionCtx.log(
                `Failed to emit retry-exhaustion error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
              );
            }
            // Ack the in-flight entry for this turn. Without this the row
            // stays `delivered` server-side forever: the in-process
            // Deduplicator collapses every bind-reset replay so the entry
            // never re-dispatches and never gets acked. Per design §4
            // "permanent → ack".
            await ackTurnClose("error", "retry_exhausted_notice_posted");
            retryBufferedMessages("claude_retry_exhausted_tail_recovery");
            failFatalSessionForRecovery(sessionCtx, "claude_retry_exhausted");
            return;
          }

          // Automatic retry — rebuild the SDK query in resume mode AND re-push
          // the unclosed inputs into the freshly built InputController.
          // The old `respawnQuery()` only did the rebuild; the new controller
          // was empty so the SDK subprocess just hung idle waiting for a
          // prompt that never came (it had the resumed conversation history
          // but nothing to drive the next turn). Replaying the unclosed input
          // buffer is the missing half — the SDK sees the same user messages
          // it was processing, including any pushed tail it had not pulled yet.
          //
          // We stay inside THIS consumer loop on purpose: spawning a fresh
          // consumer (via `handler.resume` or `spawnQuery`) would create two
          // parallel for-await loops over `currentQuery`, both stamping
          // their own retryCount counter — under a persistent failure mode
          // (e.g. SDK always throws) that fans out into unbounded recursion.
          //
          // Flush any tool_use blocks that were in-flight when the session
          // crashed so the admin event stream sees them as status:"pending"
          // rather than getting paired against a replayed tool_use_id
          // after resume.
          toolCallProcessor.flush();

          retryCount = decision.attempt;
          emitProviderTurnRetryEvent(sessionCtx, "provider_retry_scheduled", classification, decision, errMsg);
          sessionCtx.log(`Attempting auto-resume (retry ${retryCount}/${providerTurnMaxRetries})`);

          if (!(await waitForProviderRetry(decision.delayMs))) {
            sessionCtx.log("Auto-resume cancelled during provider retry backoff");
            return;
          }

          try {
            respawnQuery(claudeSessionId, sessionCtx);
          } catch (resumeErr) {
            const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
            sessionCtx.log(`Auto-resume failed: ${resumeMsg}`);
            // Mirror the MAX_RETRIES branch above and close the turn
            // deterministically so the slot can be reclaimed.
            try {
              emitAutoResumeFailedTerminalEvent({
                sessionCtx,
                classification,
                replaySafety: decision.replaySafety,
                providerMessagePreview: errMsg,
                resumeMsg,
              });
              sessionCtx.emitEvent({
                kind: "error",
                payload: { source: "runtime", message: formatAutoResumeFailedMessage(resumeMsg) },
              });
              sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
            } catch (emitErr) {
              sessionCtx.log(
                `Failed to emit auto-resume error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
              );
            }
            // Same reasoning as the MAX_RETRIES branch above — without this
            // ack the row would loop in `delivered` forever, deduped on every
            // bind-reset replay. Per design §4 "permanent → ack".
            await ackTurnClose("error", "auto_resume_failed_notice_posted");
            retryBufferedMessages("claude_auto_resume_failed_tail_recovery");
            failFatalSessionForRecovery(sessionCtx, "claude_auto_resume_failed");
            return;
          }
        }
      }
    } finally {
      // Normal completion (for-await ended) or fatal return — flush any
      // tool_use blocks that never received a tool_result as status:"pending".
      toolCallProcessor.flush();
    }
  }

  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;
  const contextTreeRepoUrl = (config.contextTreeRepoUrl as string | undefined) ?? null;
  const contextTreeBranch = (config.contextTreeBranch as string | undefined) ?? null;

  /**
   * Derive the prompt-facing source-repo list from the runtime config's
   * `gitRepos` — pure declaration, no git. The agent itself clones and
   * refreshes `<cwd>/source-repos/<localPath>/` per the protocol in its
   * briefing; the `worktrees/` subdirectory stays reserved for the per-task worktrees the
   * agent creates and cleans up on its own.
   */
  function declareSourceRepos(workspace: string, payload: AgentRuntimeConfigPayload | undefined): void {
    sourceReposForPrompt = declaredSourceRepos(workspace, payload);
  }

  /**
   * Best-effort chat-context fetch for the provider prompt path. Failures
   * are logged but never bubble — bootstrap continues with `undefined` and
   * the agent simply loses the "Current Chat Context" block for this session.
   */
  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
    try {
      return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
    } catch (err) {
      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /**
   * Probe whether the Claude Code SDK can resume the given session at the
   * current cwd. The SDK stores per-project transcripts at
   * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where
   * `encoded-cwd` is the absolute cwd with every non-alphanumeric char
   * replaced by `-`. If the file is missing, `query({ resume })` throws
   * `No conversation found with session ID: <id>` asynchronously inside
   * the consume loop, surfacing as an SDK error in the chat timeline.
   *
   * This shows up after the agent-session-cwd-redesign upgrade: per-chat
   * cwd transcripts live under a chatId-suffixed encoded path that no
   * longer matches the new per-agent-home encoding, so legacy sessionIds
   * can't be resumed in place. See proposal §⓪.3 R2.
   *
   * 🔍 Encoding rule sourcing: the `[^a-zA-Z0-9-]` → `-` substitution
   * matches Claude Agent SDK 0.2.x's on-disk behavior, verified empirically
   * by listing `~/.claude/projects/` against known cwds — an absolute path
   * like `/Users/alice/project` becomes the directory `-Users-alice-project`,
   * and `/foo/.bar` becomes `-foo--bar` (the `.` is non-alphanumeric).
   * The SDK does not export a public helper for the encoding, so an
   * upstream change here would silently invalidate this probe → fallback
   * either fails to trigger (loud SDK error returns) or triggers
   * unnecessarily (cold-start an existing session). When bumping
   * `@anthropic-ai/claude-agent-sdk`, re-verify the encoding rule.
   *
   * Returning `false` lets the caller pick either:
   *   - run the resume against a different cwd that DOES have the
   *     transcript (legacy chat dir, see `resume()` body); or
   *   - mint a fresh sessionId and fall through to start() semantics.
   */
  function claudeSessionFileExists(workspaceCwd: string, sessionId: string): boolean {
    const encoded = workspaceCwd.replace(/[^a-zA-Z0-9-]/g, "-");
    return existsSync(join(homedir(), ".claude", "projects", encoded, `${sessionId}.jsonl`));
  }

  /**
   * Build the unified briefing for the current session state — agent identity,
   * the latest `prompt.append`, source-repo list, and the Context Tree /
   * runtime sections. The handler rebuilds this on every start/resume and on
   * config hot-switch so AGENTS.md (and the CLAUDE.md symlink the Claude Code
   * SDK reads) is always current. Per-chat context is injected separately via
   * `systemPrompt.append`.
   */
  function currentBriefing(
    sessionCtx: SessionContext,
    workspace: string,
    payload: AgentRuntimeConfigPayload | null | undefined,
  ): string {
    return buildAgentBriefing({
      identity: sessionCtx.agent,
      payload: payload ?? null,
      workspacePath: workspace,
      sourceRepos: sourceReposForPrompt,
      contextTreePath,
      contextTreeRepoUrl,
      contextTreeBranch,
    });
  }

  /**
   * Run the expensive first-time bootstrap (full stable layout + `first-tree
   * tree skill install` shell-out). Gated by the stage-2 sentinel + Context-Tree
   * HEAD drift detection (proposals/agent-session-cwd-redesign §⑤.3):
   *
   *   - Sentinel absent → full bootstrap.
   *   - Sentinel present + Tree HEAD unchanged → cheap identity refresh only.
   *   - Sentinel present + Tree HEAD drifted → full bootstrap re-runs so the
   *     stable `.first-tree-workspace/` layout and first-tree skill pick up
   *     the new tree state.
   *
   * The unified briefing is rewritten on every call regardless of the drift
   * decision — the agent payload may have changed between sessions for the
   * same agent home.
   *
   * `workspaceId` for the integrate shell-out is the agent name — the home
   * directory is per-agent, so the skill identity stays stable across chats.
   */
  function ensureAgentBootstrap(
    workspace: string,
    sessionCtx: SessionContext,
    briefing: string,
    payload: AgentRuntimeConfigPayload | undefined,
  ): void {
    // Delegates to the shared helper (runtime/agent-bootstrap.ts) so the SDK
    // and TUI handlers share one briefing / core-skill / drift-pin contract
    // rather than each maintaining a partial copy.
    //
    // `currentSourceRepoNames` is threaded through to the migration applier
    // so `v1-orphan-ft-clones` can defer when the live config is unresolved
    // (cache miss). See PR #869 baixiaohang round-3 P0.
    ensureAgentBootstrapShared({
      workspace,
      sessionCtx,
      contextTreePath,
      briefing,
      currentSourceRepoNames: currentSourceRepoNamesFromPayload(payload, payload !== undefined),
    });
  }

  const handler: AgentHandler = {
    async start(message, sessionCtx, token) {
      const hasExplicitDeliveryToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      ctx = sessionCtx;
      claudeSessionId = randomUUID();
      // Per agent-session-cwd-redesign: cwd is per-agent, shared by every
      // chat session. acquireAgentHome creates the directory and writes the
      // boundary marker on first call; afterwards it is a no-op.
      cwd = acquireAgentHome(workspaceRoot);

      // Resolve chat-context and source repos before spawning the SDK:
      // source repos are rendered into the shared briefing, while chat-context
      // is appended through the SDK system prompt channel in buildQuery().
      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      const chatContext = await fetchChatContextOrLog(sessionCtx);
      chatContextForPrompt = chatContext;
      // Declare gitRepos coordinates before computing the briefing so the
      // source-repo list names the paths + upstreams the agent manages.
      declareSourceRepos(cwd, payload);
      await materializeResourceSkills(cwd, payload, sessionCtx);

      const providerEnv = buildEnv(sessionCtx);
      const briefing = currentBriefing(sessionCtx, cwd, payload);
      ensureAgentBootstrap(cwd, sessionCtx, briefing, payload);

      // Stage-2 sentinel: written once per agent home. Future starts short-
      // circuit the expensive integrate path on its presence.
      markWorkspaceInitComplete(cwd);

      // Seed the briefing baseline: a fresh session starts in sync with the
      // briefing it was built under, so its first turn carries no notice. The
      // baseline is also persisted so a resume before this session ever ran a
      // turn has a real baseline rather than reading null (a false "changed").
      currentBriefingFingerprint = computeBriefingFingerprint(briefing);
      deliveredBriefingFingerprint = currentBriefingFingerprint;
      writeSessionBriefingFingerprint(cwd, claudeSessionId, currentBriefingFingerprint);

      sessionCtx.log(
        `Starting session (${claudeSessionId}), cwd=${cwd}, permissionMode=${config.permissionMode ?? "bypassPermissions"}`,
      );
      // Convert before spawning the consumer loop, then stash/push
      // synchronously after the query exists. This preserves the retry
      // replay payload while still attaching ACK metadata before the SDK can
      // pull the prompt.
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, claudeSessionId);
      spawnQuery(claudeSessionId, sessionCtx, undefined, providerEnv);
      deliverUserMessage(sdkMsg, message, deliveryToken, claudeSessionId, sessionCtx);
      scheduleInjectedMessagesDrain(sessionCtx, claudeSessionId);

      sessionCtx.log(`Session started (${claudeSessionId})`);
      return hasExplicitDeliveryToken
        ? { sessionId: claudeSessionId, route: { kind: "owned", mode: "processing" } }
        : claudeSessionId;
    },

    async resume(message, sessionId, sessionCtx, token) {
      const hasExplicitDeliveryToken = token !== undefined;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      ctx = sessionCtx;
      claudeSessionId = sessionId;
      retryCount = 0;

      // R2 backward-compat: a session created BEFORE this PR ran with cwd =
      // `<workspaceRoot>/<chatId>/`, so its Claude SDK transcript is keyed
      // off that path's encoding under `~/.claude/projects/`. The new
      // per-agent-home cwd would NOT find it and would error with `No
      // conversation found ...`. To preserve the agent's SDK turn history
      // across upgrade, probe the legacy chat dir first — if the transcript
      // is there, run the resume against the legacy cwd verbatim and skip
      // every piece of agent-home setup (the legacy dir already has its own
      // legacy `.agent/`, CLAUDE.md, and gitRepos checkout at top-level).
      const legacyCwd = join(workspaceRoot, sessionCtx.chatId);
      const isLegacy = existsSync(legacyCwd) && claudeSessionFileExists(legacyCwd, sessionId);

      if (isLegacy) {
        cwd = legacyCwd;
        sessionCtx.log(
          `Resume: detected pre-redesign SDK transcript at legacy cwd ${legacyCwd}; ` +
            "running this session under the legacy per-chat layout to preserve agent memory",
        );
        const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
        const chatContext = await fetchChatContextOrLog(sessionCtx);
        chatContextForPrompt = chatContext;
        // Intentionally NOT calling ensureAgentBootstrap / declareSourceRepos /
        // markWorkspaceInitComplete here — those write the new
        // `.first-tree-workspace/` agent-home layout, which would pollute the
        // legacy chat dir's v1.x `.agent/` and `<localPath>/` source repos.
        //
        // We DO refresh the briefing (writeAgentBriefing only touches the
        // AGENTS.md file + CLAUDE.md symlink, not `.first-tree-workspace/`,
        // the legacy `.agent/`, or source repos) because under the
        // unified-briefing redesign AGENTS.md carries the current agent-level
        // prompt and resource-skill briefing. Current Chat Context is delivered
        // separately via `systemPrompt.append`.
        // `sourceReposForPrompt` stays `[]` here on purpose: the declared
        // paths are derived against the agent home, not the legacy cwd, so
        // the briefing's Source Repositories section is omitted for legacy
        // resumes. The agent still finds the v1.x checkouts at their
        // original `<localPath>/` — just without a top-level enumeration in
        // the prompt.
        //
        // Materialize resource skills to the legacy cwd as well. Unlike start()
        // and the normal-design resume path, this pre-redesign branch never
        // wrote them, so a skill bound to a reused legacy-layout agent (the
        // gandy-coder reuse case) never reached disk. `cwd` is `legacyCwd` here
        // (set above), NOT the agent home, so the files land where this
        // session's briefing paths and the SDK cwd resolve them.
        await materializeResourceSkills(cwd, payload, sessionCtx);
        const providerEnv = buildEnv(sessionCtx);
        writeAgentBriefing(legacyCwd, currentBriefing(sessionCtx, legacyCwd, payload));
        // Same convert-stash-then-spawn ordering as `start()` so a stream
        // error fired on the first turn of the resumed session can replay
        // through `respawnQuery`.
        let sdkMsg: SDKUserMessage | null = null;
        if (message) {
          sdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
        }
        spawnQuery(sessionId, sessionCtx, sessionId, providerEnv);
        if (sdkMsg) {
          if (message) pushPendingSdkInput(createPendingSdkInput(sdkMsg, message, deliveryToken));
        }
        scheduleInjectedMessagesDrain(sessionCtx, sessionId);
        sessionCtx.log(`Session resumed at legacy cwd (${sessionId})`);
        return hasExplicitDeliveryToken
          ? { sessionId, route: message ? { kind: "owned", mode: "processing" } : null }
          : sessionId;
      }

      // Normal new-design resume path: cwd is the agent home.
      cwd = acquireAgentHome(workspaceRoot);

      // Identical control flow to start(): bootstrap is idempotent and the
      // sentinel gates the expensive integrate. The cheap stable-identity
      // hash check runs every time so agent rename / inboxId changes
      // propagate even after the sentinel is set (R5 in the proposal).
      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      const chatContext = await fetchChatContextOrLog(sessionCtx);
      chatContextForPrompt = chatContext;
      declareSourceRepos(cwd, payload);
      await materializeResourceSkills(cwd, payload, sessionCtx);

      const providerEnv = buildEnv(sessionCtx);
      const briefing = currentBriefing(sessionCtx, cwd, payload);
      ensureAgentBootstrap(cwd, sessionCtx, briefing, payload);

      markWorkspaceInitComplete(cwd);

      // Defensive fallback: sessionId isn't recognised at EITHER cwd (likely
      // a stale registry entry from machine swap / fs cleanup / tampering).
      // Mint a fresh id and start cold — First Tree message history survives.
      if (!claudeSessionFileExists(cwd, sessionId)) {
        const freshSessionId = randomUUID();
        sessionCtx.log(
          `Resume: SDK transcript for ${sessionId} not found at legacy (${legacyCwd}) ` +
            `or agent home (${cwd}); starting fresh session ${freshSessionId} — ` +
            "First Tree message history is preserved.",
        );
        claudeSessionId = freshSessionId;
        // Cold start under a fresh id: seed the baseline in sync, so the first
        // turn carries no notice — there is no prior transcript built under a
        // stale briefing to warn about.
        currentBriefingFingerprint = computeBriefingFingerprint(briefing);
        deliveredBriefingFingerprint = currentBriefingFingerprint;
        writeSessionBriefingFingerprint(cwd, freshSessionId, currentBriefingFingerprint);
        let freshSdkMsg: SDKUserMessage | null = null;
        if (message) {
          freshSdkMsg = await toSDKUserMessage(message, sessionCtx, freshSessionId);
        }
        spawnQuery(freshSessionId, sessionCtx, undefined, providerEnv);
        if (freshSdkMsg && message) {
          deliverUserMessage(freshSdkMsg, message, deliveryToken, freshSessionId, sessionCtx);
        }
        scheduleInjectedMessagesDrain(sessionCtx, freshSessionId);
        sessionCtx.log(`Session started (${freshSessionId}, replacing ${sessionId})`);
        return hasExplicitDeliveryToken
          ? { sessionId: freshSessionId, route: message ? { kind: "owned", mode: "processing" } : null }
          : freshSessionId;
      }

      sessionCtx.log(`Resuming session (${sessionId}), cwd=${cwd}`);

      // Briefing-staleness baseline for this resumed session. `current` is the
      // briefing just rewritten above; `delivered` loads the fingerprint the
      // session last ran a turn under — null means a session predating this
      // mechanism, treated as changed so it gets one re-read nudge. The compare
      // + notice + baseline advance happen in deliverUserMessage, after the
      // input is buffered (a no-message reclaim advances nothing, so the next
      // real turn still surfaces the change).
      currentBriefingFingerprint = computeBriefingFingerprint(briefing);
      deliveredBriefingFingerprint = readSessionBriefingFingerprint(cwd, sessionId);

      let resumeSdkMsg: SDKUserMessage | null = null;
      if (message) {
        resumeSdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
      }
      spawnQuery(sessionId, sessionCtx, sessionId, providerEnv);
      if (resumeSdkMsg && message) {
        deliverUserMessage(resumeSdkMsg, message, deliveryToken, sessionId, sessionCtx);
      }
      scheduleInjectedMessagesDrain(sessionCtx, sessionId);

      sessionCtx.log(`Session resumed (${sessionId})`);
      return hasExplicitDeliveryToken
        ? { sessionId, route: message ? { kind: "owned", mode: "processing" } : null }
        : sessionId;
    },

    inject(message, token) {
      if (!claudeSessionId || !ctx) {
        ctx?.log("inject() called but no active session — dropping message");
        return { kind: "rejected", reason: "no_active_session", retryable: true };
      }
      const sessionCtx = ctx;
      const deliveryToken = token ?? deliveryTokenFromSessionContext(sessionCtx);
      const sid = claudeSessionId;
      queuedInjectedMessages.push({ message, token: deliveryToken });
      scheduleInjectedMessagesDrain(sessionCtx, sid);
      return { kind: "owned", mode: "queued" };
    },

    async suspend(reason?: string) {
      ctx?.log("Suspending session");
      retireProviderTransport();

      // Wait for consumer loop to finish
      if (consumerDone) {
        await consumerDone.catch(() => {});
        consumerDone = null;
      }

      // The session is no longer active — any pending replay inputs would be
      // moot. Resume goes through `handler.resume(message, sessionId)`, which
      // builds a fresh replay buffer from its own pushed inputs.
      retryBufferedMessages(reason ?? "claude_suspend_before_terminal");
      injectDrainInProgress = false;
    },

    async shutdown(reason?: string) {
      await handler.suspend(reason);
      // Per agent-session-cwd-redesign: cwd is the per-agent home — shared
      // by every chat. shutdown() of ONE chat must NOT remove it (would
      // wipe persistent state and worktrees other chats are using).
      //
      // Source repos and the Context Tree clone are agent-managed state
      // (the agent clones / refreshes them per its briefing protocol), and
      // on-demand worktrees under `<cwd>/worktrees/<name>/` live until the
      // agent itself removes them when the task closes (e.g. on PR merge) —
      // the runtime touches none of them on shutdown.
      cwd = null;
    },
  };

  return handler;
};
