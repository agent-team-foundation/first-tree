import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EffortLevel,
  McpServerConfig,
  PermissionMode,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeConfigPayload, SessionEvent, SupportedImageMime, ToolFileRef } from "@first-tree/shared";
import {
  isImageBatchRefContent,
  isImageRefContent,
  SUPPORTED_IMAGE_MIMES as SHARED_SUPPORTED_IMAGE_MIMES,
} from "@first-tree/shared";
import { ensureAgentBootstrap as ensureAgentBootstrapShared } from "../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { type PredeclaredSourceRepo, writeAgentBriefing } from "../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../runtime/chat-context.js";
import { toolFileRefsFromShellCommand } from "../runtime/context-tree-file-refs.js";
import { classify } from "../runtime/error-taxonomy.js";
import type { GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { ResumeUnavailableError } from "../runtime/handler.js";
import { findImagePath } from "../runtime/image-store.js";
import { InputController } from "../runtime/input-controller.js";
import { materializeResourceSkills } from "../runtime/resource-skills.js";
import {
  currentSourceRepoNamesFromPayload,
  prepareSourceRepos as prepareSourceReposShared,
  releaseSourceReposForSession,
} from "../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../runtime/workspace.js";
import { formatAuthHint, isClaudeAuthError } from "./auth-error-hint.js";
import { resolveClaudeCodeExecutable } from "./claude-executable.js";

const MAX_RETRIES = 2;

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

const TOOL_RESULT_PREVIEW_LIMIT = 400;
const ASSISTANT_TEXT_EVENT_LIMIT = 8000;

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

type ResultMessage = {
  type: "result";
  subtype: string;
  result?: string;
  errors?: string[];
  duration_ms?: number;
  total_cost_usd?: number;
  num_turns?: number;
  session_id?: string;
  // Per-model token usage for this turn. Anthropic's Claude Agent SDK populates
  // this on every ResultMessage (success and error subtypes). A single turn can
  // span multiple models (e.g. fast-mode), so we emit one `token_usage` event
  // per entry. Keys are model identifiers (e.g. "claude-opus-4-7"). Older SDK
  // versions may omit the field entirely — treat absence as "no usage to emit"
  // rather than an error.
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
 * Emit one `token_usage` event per (model) entry in the result's `modelUsage`.
 * The SDK lumps cache-creation tokens under their own field, but the wire
 * schema folds them into `inputTokens` because they bill as input. Best-effort:
 * a missing/empty `modelUsage` is silently skipped (older SDKs and some error
 * subtypes don't populate it). Per-entry emit failures are swallowed so token
 * accounting never blocks the turn close that follows.
 */
function emitTokenUsageFromResult(message: ResultMessage, sessionCtx: SessionContext): void {
  const usage = message.modelUsage;
  if (!usage) return;
  for (const [model, m] of Object.entries(usage)) {
    if (!m) continue;
    const cacheCreation = m.cacheCreationInputTokens ?? 0;
    const cachedRead = m.cacheReadInputTokens ?? 0;
    const inputTokens = (m.inputTokens ?? 0) + cacheCreation;
    const outputTokens = m.outputTokens ?? 0;
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

/**
 * Tools whose `file_path` argument names a single file. Search tools
 * (Grep/Glob) are excluded because they need server-side command/query
 * semantics before they can be treated as an explicit file IO fact.
 */
const TREE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "NotebookRead"]);
const TREE_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit"]);

/** Extract a string `file_path` argument from a tool_use input, if present. */
function readFilePathArg(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const fp = (input as { file_path?: unknown }).file_path;
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
  const repoRelativePath = contextTree?.path ? treeNodePathOf(filePath, contextTree.path) : null;
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
  options: { cwd?: string | null } = {},
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
    const refs = status === "ok" ? toolFileRefs(entry.name, entry.args, contextTree, options.cwd) : [];

    emit({
      kind: "tool_call",
      payload: {
        toolUseId: entry.toolUseId,
        name: entry.name,
        args: entry.args,
        status,
        durationMs,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
        ...(refs.length > 0 ? { toolFileRefs: refs } : {}),
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
            emit({
              kind: "assistant_text",
              payload: { text: text.slice(0, ASSISTANT_TEXT_EVENT_LIMIT) },
            });
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
};

/**
 * Build the config-derived slice of the SDK query options (model, MCP
 * servers, reasoning effort). Kept pure and exported so these mappings are
 * unit-testable; the session-bound options (env, canUseTool, abortController,
 * sessionId/resume) stay inline in `buildQuery`.
 *
 * Per-agent prompt instructions, working-directory convention, source-repo
 * list, and Current Chat Context land in `<cwd>/AGENTS.md` (which `CLAUDE.md`
 * symlinks to). The Claude Code SDK loads CLAUDE.md via `settingSources:
 * ["project"]`, so the briefing file is the single channel — there is no
 * SDK-side `systemPrompt.append` anymore.
 *
 * Reasoning effort: the claude variant's `""` is an inherit sentinel — when
 * set we omit the `effort` option so the SDK falls back to the operator's local
 * `~/.claude/settings.json` effortLevel (preserving pre-feature behavior). A
 * non-empty value is passed explicitly and overrides that local setting.
 */
export function buildClaudeQueryOptions(payload: AgentRuntimeConfigPayload | undefined): ClaudeQueryConfigOptions {
  const options: ClaudeQueryConfigOptions = {};
  if (payload?.model) options.model = payload.model;
  if (payload?.mcpServers.length) options.mcpServers = mapMcpServers(payload);
  if (payload?.kind === "claude-code" && payload.reasoningEffort) {
    options.effort = payload.reasoningEffort;
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
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const gitMirrorManager = (config.gitMirrorManager as GitMirrorManager | undefined) ?? null;
  // Pre-resolved by registerBuiltinHandlers at process start. Undefined =
  // defer to the SDK's bundled native binary (see claude-executable.ts for
  // why we can't always rely on it).
  const claudeCodeExecutable =
    (config.claudeCodeExecutable as string | undefined) ?? resolveClaudeCodeExecutable().path;

  let cwd: string | null = null;
  let claudeSessionId: string | null = null;
  let currentQuery: Query | null = null;
  let inputController: InputController<SDKUserMessage> | null = null;
  let abortController: AbortController | null = null;
  let consumerDone: Promise<void> | null = null;
  let retryCount = 0;
  let ctx: SessionContext | null = null;
  /** Snapshot of the runtime config the *current* sub-process was launched with. */
  let appliedConfigVersion = 0;
  let appliedModel = "";
  let appliedPayload: AgentRuntimeConfigPayload | null = null;
  /**
   * On-demand worktrees materialised for this session — each entry `rm -rf`'d on
   * shutdown via `removeSourceRepo`. INVARIANT: only ever push paths under
   * `<agentHome>/worktrees/` here. NEVER push a predeclared source-repo path —
   * those are agent-scoped persistent clones shared across chats, and cleanup
   * would delete another chat's checkout. (Currently nothing pushes here.)
   */
  const ownedWorktrees: Array<{ clonePath: string }> = [];
  /**
   * Latest chat-context snapshot for the active session. Used to build the
   * per-turn system-prompt block injected via `systemPrompt.append`. Cleared
   * when the session ends or `start()` runs for a fresh session.
   */
  let chatContextForPrompt: ChatContext | undefined;
  const queuedInjectedMessages: SessionMessage[] = [];
  const pendingAckMessages: SessionMessage[] = [];
  let injectDrainInProgress = false;
  /**
   * Predeclared source repos materialised by `prepareSourceRepos`. Surfaced in
   * the per-turn prompt block so the LLM knows the absolute paths without
   * having to discover them.
   */
  /**
   * Predeclared source repos materialised at `<agentHome>/<localPath>/` by
   * `prepareSourceRepos`. Surfaced in the per-chat system-prompt block so
   * the LLM knows their absolute paths. NOT to be confused with on-demand
   * worktrees the agent itself creates under `<agentHome>/worktrees/<name>/`
   * — those are runtime-opaque (created by the agent, not by First Tree).
   */
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];
  /**
   * The most recently pushed SDK user message, kept around as the replay
   * payload for the transient stream-API retry path. Stashed at every
   * `inputController.push` site (start / resume / inject) so a
   * `claude_socket_closed` retry can re-push it into the rebuilt query —
   * without this, `respawnQuery()` would leave the new `InputController`
   * empty and the SDK subprocess would hang idle (resume mode loads
   * conversation history but still needs a new user message to drive
   * the next turn). We stash the already-converted SDK form (rather
   * than the raw `SessionMessage`) so the retry path stays synchronous
   * and timing-compatible with the existing consumer-loop catch block.
   * Cleared once `finishTurnClose()` finishes the entry — turn fully processed,
   * no further replay needed.
   *
   * Invariant — single-consumer loop: this stash is safe ONLY because
   * the catch → respawn → re-push sequence in `consumeOutput` is
   * synchronous (no `await` between the sniff-throw catch entry and
   * `respawnQuery`'s push). The interleaving inject() runs on its own
   * `void maybeSwitchConfig().finally(...)` microtask and updates the
   * stash via the same write site, so a properly-ordered consumer-loop
   * iteration is the *only* reader and writer at any synchronous step.
   * If future work ever introduces a second concurrent consumer (e.g.
   * parallel turn execution, multi-`spawnQuery` fan-out), this stash
   * must be redesigned per-consumer or the retry must own its own
   * captured copy — otherwise an inject from chat N can overwrite a
   * stash that chat M's retry is about to replay.
   *
   * Tolerated same-chat race — inject mid-retry: an inject()'s
   * `toSDKUserMessage` await can interleave with a consumer-triggered
   * transient retry. Sequence: consumer sniff-hit → respawn replays
   * the PRIOR stash into the new query → inject's await resolves →
   * inject overwrites stash and pushes the new prompt. The rebuilt
   * query then sees `[replayed_prior_prompt, injected_new_prompt]`
   * as two consecutive user messages. The replayed prompt is already
   * in the resumed conversation history, so the model perceives a
   * one-message duplicate before processing the inject — recoverable,
   * not a correctness break. Avoiding this would require either
   * draining inject through a queue gated on the consumer's catch
   * state or making the retry path async — both have larger blast
   * radius than the duplicate-message symptom. Documented per PR #648
   * reviewer observation #1.
   */
  let stashedSdkMessage: SDKUserMessage | null = null;

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
      // Resolve the sender's chat-local name once up front so both branches
      // emit the same `[From: <name>]` header as the default text path.
      const senderLabel = message.senderId ? await sessionCtx.resolveSenderLabel(message.senderId) : "";
      const prefix = senderLabel ? `[From: ${senderLabel}]\n\n` : "";

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
  function spawnQuery(sessionId: string, sessionCtx: SessionContext, resume?: string): void {
    // The latest chat-context and source-repo snapshot live in module-scoped
    // caches (`chatContextForPrompt`, `sourceReposForPrompt`) which the
    // handler refreshes in start/resume BEFORE this call. `maybeSwitchConfig`
    // additionally rewrites the briefing before invoking `buildQuery` so a
    // mid-session config swap surfaces in the freshly read CLAUDE.md.
    buildQuery(sessionId, sessionCtx, resume);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
  }

  /**
   * Single helper for "turn closed → finish the pending inbox message AND
   * drop the replay stash". The two operations are paired everywhere a
   * turn finishes (success / sniff-permanent / forward-error / no-result /
   * non-success subtype / MAX_RETRIES / respawn-fail) — folding them into
   * one call keeps the invariant "stash lives only as long as the turn
   * still might need a replay" enforced in one place. Use the raw
   * `finishTurn(message, outcome)` directly for per-message terminal
   * failures (e.g. inject's `toSDKUserMessage` catch) where the semantics is
   * "commit this single inbox message, NOT close the active SDK turn".
   */
  async function finishTurnClose(
    sessionCtx: SessionContext,
    outcome: { status: "success" | "error"; terminal?: boolean },
  ): Promise<void> {
    const message = pendingAckMessages.shift();
    await sessionCtx.finishTurn(message ? [message] : [], outcome);
    markCurrentPendingMessageConsumed(sessionCtx);
    stashedSdkMessage = null;
  }

  function pushPendingAckMessage(message: SessionMessage, sessionCtx: SessionContext): void {
    const wasEmpty = pendingAckMessages.length === 0;
    pendingAckMessages.push(message);
    if (wasEmpty) sessionCtx.markMessagesConsumed(message);
  }

  function markCurrentPendingMessageConsumed(sessionCtx: SessionContext): void {
    const current = pendingAckMessages[0];
    if (current) sessionCtx.markMessagesConsumed(current);
  }

  async function pushInjectedMessage(
    message: SessionMessage,
    sessionCtx: SessionContext,
    sessionId: string,
  ): Promise<void> {
    try {
      await maybeSwitchConfig(sessionCtx);
    } catch (err) {
      sessionCtx.log(`maybeSwitchConfig errored: ${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
      stashedSdkMessage = sdkMsg;
      inputController?.push(sdkMsg);
      pushPendingAckMessage(message, sessionCtx);
    } catch (err) {
      sessionCtx.log(`toSDKUserMessage errored: ${err instanceof Error ? err.message : String(err)}`);
      // `toSDKUserMessage` failed before the SDK ever saw the
      // message, so no `result` event will ever fire to pair this
      // entry with an SDK result. Ack here — re-handling on
      // redelivery would re-hit the same conversion error
      // (permanent failure semantics, design §4).
      await sessionCtx.finishTurn(message, { status: "error", terminal: true });
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
          const message = queuedInjectedMessages.shift();
          if (!message) continue;
          await pushInjectedMessage(message, sessionCtx, sessionId);
        }
      } finally {
        injectDrainInProgress = false;
        if (queuedInjectedMessages.length > 0 && inputController && ctx && claudeSessionId) {
          scheduleInjectedMessagesDrain(ctx, claudeSessionId);
        }
      }
    })();
  }

  /**
   * Rebuild the SDK query in resume mode AND re-push the pending user
   * message so the freshly built `InputController` is non-empty. The
   * caller (the outer consumer loop's catch block) keeps owning the
   * for-await, so we deliberately do NOT start a new consumer here —
   * spawning one would create two parallel loops both consuming the
   * same `currentQuery` reference and both racing their own
   * `retryCount` counter (under persistent failure, that fans out into
   * unbounded recursion). Configuration (`applied*`) is preserved
   * across the retry — only the SDK query is recycled.
   *
   * Stays synchronous — the converted SDK payload is stashed at push
   * time so the retry path doesn't need to re-run `toSDKUserMessage`
   * (which is async and would shift the consumer-loop timing).
   *
   * `stashedSdkMessage` is `null` only in the corner case where the
   * session was started via `handler.resume(undefined, ...)` (admin-
   * triggered resume with no new user input) and the SDK happened to
   * crash before processing anything. In that case we still rebuild
   * the query, but without a replay message the SDK will be back to
   * waiting on stdin — acceptable for the admin-resume edge case, and
   * the next user message will drive it normally.
   */
  function respawnQuery(sessionId: string, sessionCtx: SessionContext): void {
    buildQuery(sessionId, sessionCtx, sessionId);
    if (stashedSdkMessage) {
      inputController?.push(stashedSdkMessage);
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

  function buildQuery(sessionId: string, sessionCtx: SessionContext, resume?: string): void {
    inputController = new InputController<SDKUserMessage>();
    abortController = new AbortController();

    // Step 6: M1 hard-codes bypassPermissions per PRD §5.1.6 (permission mode
    // is intentionally not exposed to admins).
    const permissionMode: PermissionMode = "bypassPermissions";

    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;

    currentQuery = claudeQuery({
      prompt: inputController.iterable,
      options: {
        sessionId: resume ? undefined : sessionId,
        resume,
        cwd: cwd ?? undefined,
        persistSession: true,
        abortController,
        permissionMode,
        allowDangerouslySkipPermissions: true,
        // SDK 0.2.84 defaults to isolation mode — no filesystem settings are
        // read. We opt into both `user` and `project`:
        //   - `project` loads the workspace CLAUDE.md (symlinked to AGENTS.md
        //     written by `writeAgentBriefing`). That single briefing carries
        //     identity, the per-agent prompt.append, working-dir convention,
        //     source-repo list, Current Chat Context, operating instructions,
        //     domain map, and the First Tree Agent Runtime block — the entire
        //     channel that used to split between SDK `systemPrompt.append` and
        //     a stable CLAUDE.md is now this one file.
        //   - `user` inherits the operator's local `~/.claude/settings.json`
        //     so their Claude Code customizations (thinking mode, effortLevel,
        //     outputStyle, statusLine, plugins, skills, hooks, MCP servers)
        //     carry over to agent sessions on their machine. Server-managed
        //     fields (model, env, permissionMode, and the First Tree
        //     `mcpServers` list) still win because they are passed as
        //     explicit SDK options below, which layer on top of settings.
        settingSources: ["user", "project"],
        env: buildEnv(sessionCtx),
        // AskUserQuestion is not supported in First Tree — agents resolve
        // ask-a-human inline. Disable the tool at the SDK level so it never
        // surfaces in a session.
        disallowedTools: ["AskUserQuestion"],
        ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
        // model / mcpServers / effort — the config-derived slice. `effort: ""`
        // (inherit) is omitted so the SDK uses the local effortLevel.
        ...buildClaudeQueryOptions(payload),
      },
    });
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
    if (onlyModelChanged && isSameModelFamily(appliedModel, newPayload.model)) {
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
    // Rewrite AGENTS.md (CLAUDE.md symlink) with the new payload so the
    // restarted SDK Query — which reads CLAUDE.md via `settingSources:
    // ["project"]` on construction — picks up the new prompt.append. The
    // briefing is now the single channel; without this rewrite the swap
    // would update model/mcp/effort but silently leave the per-agent prompt
    // at the old version until the next session restart.
    if (cwd) {
      writeAgentBriefing(cwd, currentBriefing(sessionCtx, cwd, newPayload));
    }
    const sid = claudeSessionId;
    const oldQuery = currentQuery;
    buildQuery(sid, sessionCtx, sid);
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
    const toolCallProcessor = createToolCallProcessor(
      (event) => sessionCtx.emitEvent(event),
      {
        path: contextTreePath,
        repoUrl: contextTreeRepoUrl,
        branch: contextTreeBranch,
      },
      { cwd },
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
    try {
      while (true) {
        if (!currentQuery) return;

        try {
          sessionCtx.recordProviderActivity();

          for await (const message of currentQuery) {
            // Every message refreshes lastActivity to prevent idle timeout
            sessionCtx.recordProviderActivity();

            toolCallProcessor.onMessage(message);

            // Detect typed auth failure BEFORE result-message handling so the
            // user sees the actionable hint before any redundant result error.
            // The SDK's auth state lives in claude's own credential store —
            // we only translate the surface error, we don't manage tokens.
            const authFailure = detectClaudeAuthFailure(message);
            if (authFailure && !authHintEmitted) {
              authHintEmitted = true;
              sessionCtx.emitEvent({
                kind: "error",
                payload: { source: "sdk", message: formatAuthHint("claude-code", authFailure.rawMessage) },
              });
            }

            if (isResultMessage(message)) {
              emitTokenUsageFromResult(message, sessionCtx);
              if (message.subtype === "success") {
                // Auto-bridge: forward result text back to the chat and close
                // the turn. We AWAIT sendMessage (rather than fire-and-forget)
                // so the turn_end emit is guaranteed to hit the WebSocket
                // before the for-await pulls the next turn's first event.
                // Otherwise a slow sendMessage round-trip could let the
                // server assign a smaller seq to turn N+1's thinking/tool_call
                // than to turn N's turn_end — which would cause the frontend's
                // "latest turn_end" filter to retroactively hide turn N+1's
                // live events. If the forward fails the text is otherwise
                // lost (no session_output table since NC2) — surface it via
                // the events API so admins see both the failure and a
                // snapshot of what would have been sent.
                if (message.result && sessionCtx.chatId) {
                  const resultText = message.result;
                  // Bug 6: SDK sometimes packages its own catch'd API error
                  // as a `result.subtype === "success"` payload. Sniff
                  // before forwarding so the user does not see raw "API
                  // Error: socket closed" text as a model reply.
                  const sniff = detectStreamApiError(resultText);
                  if (sniff) {
                    const classification = classify(new Error(sniff.message), { source: "stream" });
                    sessionCtx.log(
                      `Stream API error detected (${classification.kind}/${classification.reasonCode}): ${sniff.message}`,
                    );
                    // Design §6.1: emit `resilience.stream.api_error_detected`
                    // on BOTH transient and permanent paths via the closed-kind
                    // bridge (encoded into the `error` event message).
                    sessionCtx.emitEvent({
                      kind: "error",
                      payload: {
                        source: "runtime",
                        message: `resilience.stream.api_error_detected: ${JSON.stringify({
                          reasonCode: classification.reasonCode,
                          kind: classification.kind,
                          messagePreview: sniff.message.slice(0, 200),
                        })}`,
                      },
                    });
                    if (classification.kind === "transient" && retryCount < MAX_RETRIES) {
                      // Re-throw to drive the outer catch's auto-resume path
                      // (retry counter + self-resume via handler.resume).
                      throw new StreamApiTransientError(sniff.message);
                    }
                    // Permanent (401/403) OR retries exhausted: surface to
                    // chat as an error event so the user sees what happened.
                    // Skip forwardResult so the raw "API Error" text never
                    // appears as a model reply in the timeline.
                    sessionCtx.emitEvent({
                      kind: "error",
                      payload: {
                        source: "sdk",
                        message: `Claude API error (${classification.reasonCode}): ${sniff.message}`,
                      },
                    });
                    // Permanent stream API failure — ack so the server
                    // doesn't redeliver a message that would just produce
                    // the same error. Retry was exhausted upstream.
                    await finishTurnClose(sessionCtx, { status: "error" });
                  } else {
                    // Genuine success — reset retry budget for the next turn.
                    // Do NOT reset on the sniff-hit branches above: a wrapped
                    // transient API error masquerades as `subtype: "success"`
                    // and we MUST let `retryCount` accumulate so MAX_RETRIES
                    // can fire and break us out of an unhealing transient
                    // loop (rate limit / socket closed / etc.).
                    retryCount = 0;
                    try {
                      // All enrichment (inReplyTo, mentions, participants
                      // lookup, transport) lives in ctx.forwardResult so every
                      // handler shares one code path — see runtime/result-sink.ts.
                      await sessionCtx.forwardResult(resultText);
                      sessionCtx.log("Result forwarded to chat");
                      // Turn closed cleanly — drain in-flight inbox entries.
                      await finishTurnClose(sessionCtx, { status: "success" });
                    } catch (err) {
                      const reason = err instanceof Error ? err.message : String(err);
                      sessionCtx.log(`Failed to forward result: ${reason}`);
                      const preview = resultText.slice(0, 1500);
                      const forwardErrMessage = `Result forward failed: ${reason}\n---\n${preview}`.slice(0, 2000);
                      sessionCtx.emitEvent({
                        kind: "error",
                        payload: { source: "runtime", message: forwardErrMessage },
                      });
                      // forwardResult failure is treated as terminal for
                      // this turn — ack so we don't loop on redelivery.
                      // Long-lived sdk.sendMessage failures are rare; if
                      // recovery is needed the user can retry by sending
                      // a new message.
                      //
                      // Reset retryCount along with the forward-success
                      // branch above: the SDK actually returned a clean
                      // `result` here (the failure was in our own
                      // sendMessage downstream), so the next turn should
                      // not inherit the prior turn's transient-retry
                      // counter when an unrelated future stream error
                      // fires.
                      retryCount = 0;
                      await finishTurnClose(sessionCtx, { status: "error" });
                    }
                  }
                } else {
                  // No result text to forward (edge case) — still close the turn.
                  // Same reset rationale as the forward-success branch above.
                  retryCount = 0;
                  await finishTurnClose(sessionCtx, { status: "success" });
                }
              } else {
                const errors = message.errors ? message.errors.join("; ") : message.subtype;
                const errorLog = `Query result error: ${errors} (subtype=${message.subtype}, turns=${message.num_turns ?? "?"}, duration=${message.duration_ms ?? "?"}ms)`;
                sessionCtx.log(errorLog);
                // If we already emitted an auth-failure hint earlier in this
                // turn (typed `authentication_failed` on an assistant /
                // api_retry / auth_status message), skip the raw SDK error
                // emit so the timeline shows the actionable hint instead of
                // a redundant opaque second line.
                if (!authHintEmitted) {
                  sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: errors } });
                }
                // SDK reported a turn-level error (non-success subtype):
                // redelivery would just hit the same error — ack.
                await finishTurnClose(sessionCtx, { status: "error" });
              }
              // Reset the auth-hint flag only on a SUCCESSFUL result. This
              // gives a clean slate for the next turn once auth is clearly
              // working, while suppressing a duplicate hint when the next
              // turn (or a retry — see flag declaration above) hits the same
              // unhealing auth failure. The user has already been told what
              // to do; repeating it adds noise without new information.
              if (message.subtype === "success") {
                authHintEmitted = false;
              }
            }
          }
          return;
        } catch (err) {
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

          if (retryCount >= MAX_RETRIES || !claudeSessionId) {
            sessionCtx.log("Exhausted retries, session will be suspended");
            // Surface to the chat timeline so the user sees the failure and
            // doesn't think the agent silently stalled. The MAX_RETRIES
            // case in particular drops the turn entirely — no result will
            // be forwarded — so without an explicit error event the chat
            // would just go quiet.
            //
            // Wrap the emits so a broken `onSessionEvent` callback can't
            // short-circuit the terminal `finishTurn` call below —
            // if that one is skipped the SessionManager keeps the slot
            // counted as `working` and never reclaims it.
            try {
              const preview = errMsg.slice(0, 800);
              const reason = claudeSessionId
                ? `Query failed after ${MAX_RETRIES} retries: ${preview}`
                : `Query failed and no resume id available: ${preview}`;
              sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: reason } });
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
            await finishTurnClose(sessionCtx, { status: "error", terminal: true });
            return;
          }

          // Automatic retry — rebuild the SDK query in resume mode AND re-push
          // the pending user message into the freshly built InputController.
          // The old `respawnQuery()` only did the rebuild; the new controller
          // was empty so the SDK subprocess just hung idle waiting for a
          // prompt that never came (it had the resumed conversation history
          // but nothing to drive the next turn). Replaying `stashedSdkMessage`
          // is the missing half — the SDK sees the same user message it was
          // half-way through processing and re-runs the turn.
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

          retryCount++;
          sessionCtx.log(`Attempting auto-resume (retry ${retryCount}/${MAX_RETRIES})`);

          try {
            respawnQuery(claudeSessionId, sessionCtx);
          } catch (resumeErr) {
            const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
            sessionCtx.log(`Auto-resume failed: ${resumeMsg}`);
            // Mirror the MAX_RETRIES branch above: finish the turn with a
            // terminal error marker so the SessionManager can reclaim/report
            // the session even if event callbacks fail.
            try {
              sessionCtx.emitEvent({
                kind: "error",
                payload: { source: "runtime", message: `Auto-resume failed: ${resumeMsg.slice(0, 800)}` },
              });
            } catch (emitErr) {
              sessionCtx.log(
                `Failed to emit auto-resume error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
              );
            }
            // Same reasoning as the MAX_RETRIES branch above — without this
            // ack the row would loop in `delivered` forever, deduped on every
            // bind-reset replay. Per design §4 "permanent → ack".
            await finishTurnClose(sessionCtx, { status: "error", terminal: true });
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
  // `agentName` is the operator-chosen stable identifier (`config.yaml`'s
  // `agents.<name>` key). Carried through to the per-session bootstrap so a
  // single agent's multi-chat workspaces share the same workspace identity
  // instead of churning a new id per chat.
  const agentName = (config.agentName as string | undefined) ?? null;

  /**
   * Materialise the runtime config's `gitRepos` as **predeclared source
   * repos** at the **top level** of the agent home (`<cwd>/<localPath>/`),
   * NOT under `<cwd>/worktrees/`. Per the 2026-05-22 redesign, the
   * `worktrees/` subdirectory is reserved entirely for agent-on-demand
   * worktrees the LLM creates per task — the runtime never pre-creates any.
   *
   * Idempotent across sessions: with the per-agent-home model the checkout
   * is **shared** across every chat for this agent. First call clones the
   * repo as a standalone clone; subsequent calls fetch and — when the
   * checkout is clean and not in use by another live session — bring it to
   * the latest default branch. A dirty or in-use checkout is left at its
   * current commit, so pending state the LLM left behind survives.
   *
   * Concurrency: the manager serialises per clone path so two sessions
   * starting at the same time don't race a clone / update for the same path.
   * See proposals/agent-session-cwd-redesign.20260519.md §⑧ R1.
   *
   * Side effect: refreshes `sourceReposForPrompt` so the unified briefing
   * builder (`runtime/agent-briefing.ts` → `## Source Repositories`) can
   * list absolute paths + upstream coordinates for the LLM.
   *
   * Fail-fast semantics per PRD D10/D13/D14: any failure aborts the session
   * and the error bubbles up to the caller (SessionManager).
   */
  async function prepareSourceRepos(
    workspace: string,
    payload: AgentRuntimeConfigPayload | undefined,
    sessionCtx: SessionContext,
  ): Promise<void> {
    // Delegates to the shared helper (runtime/source-repos.ts) so the SDK and
    // TUI handlers share one worktree-lock / Hub-marker implementation rather
    // than each carrying its own source-repo invariant.
    //
    // `payloadResolved` distinguishes "agent config truly says zero repos"
    // from "we couldn't reach the cache/server and `payload` is undefined".
    // Without this gate, a cache miss would compute an empty current-repo
    // set and the state-reconcile path would `rm` every previously-managed
    // clone. See `PrepareSourceReposParams.payloadResolved`.
    sourceReposForPrompt = await prepareSourceReposShared({
      workspace,
      payload,
      sessionCtx,
      gitMirrorManager,
      agentName,
      payloadResolved: payload !== undefined,
    });
  }

  /** Tear down all worktrees this session owns; best-effort. */
  async function cleanupGitWorktrees(sessionCtx: SessionContext): Promise<void> {
    // Drop this session's live-use references on shared source-repo checkouts so
    // a later session is free to bring them to the latest default branch.
    releaseSourceReposForSession(sessionCtx);
    if (!gitMirrorManager) return;
    while (ownedWorktrees.length > 0) {
      const entry = ownedWorktrees.pop();
      if (!entry) continue;
      try {
        await gitMirrorManager.removeSourceRepo(entry);
      } catch (err) {
        sessionCtx.log(
          `Git: removeSourceRepo(${entry.clonePath}) failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Best-effort chat-context fetch for the identity-injection path. Failures
   * are logged but never bubble — bootstrap continues with `undefined` and
   * the agent simply loses the "Current Chat Context" block (graceful
   * degradation; the Communication block in the `# Working in First Tree`
   * section of AGENTS.md still tells it to fall back to conservative mode).
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
   * the latest `prompt.append`, source-repo list, the latest chat-context
   * snapshot, and the Context Tree / runtime sections. The handler rebuilds
   * this on every start/resume and on config hot-switch so AGENTS.md (and the
   * CLAUDE.md symlink the Claude Code SDK reads) is always current.
   */
  function currentBriefing(
    sessionCtx: SessionContext,
    workspace: string,
    payload: AgentRuntimeConfigPayload | null | undefined,
  ): string {
    return buildAgentBriefing({
      identity: sessionCtx.agent,
      payload: payload ?? null,
      chatContext: chatContextForPrompt,
      workspacePath: workspace,
      sourceRepos: sourceReposForPrompt,
      contextTreePath,
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
   * decision — chat context and the agent payload may have changed between
   * sessions for the same agent home.
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
    async start(message, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = randomUUID();
      // Per agent-session-cwd-redesign: cwd is per-agent, shared by every
      // chat session. acquireAgentHome creates the directory and writes the
      // boundary marker on first call; afterwards it is a no-op.
      cwd = acquireAgentHome(workspaceRoot);

      // Resolve the per-chat inputs that drive the unified briefing BEFORE
      // bootstrap: the briefing is the single channel that materialises agent
      // identity, payload.prompt.append, source-repo list, and Current Chat
      // Context for the Claude Code SDK (read via `settingSources:
      // ["project"]` from CLAUDE.md → AGENTS.md). Bootstrap must therefore
      // see fully-resolved inputs.
      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      const chatContext = await fetchChatContextOrLog(sessionCtx);
      chatContextForPrompt = chatContext;
      // Materialise gitRepos under `<cwd>/<localPath>/` before computing the
      // briefing so the source-repo list reflects what the agent will see on
      // disk. Failures here abort session creation (D10/D13).
      await prepareSourceRepos(cwd, payload, sessionCtx);
      await materializeResourceSkills(cwd, payload, sessionCtx);

      const briefing = currentBriefing(sessionCtx, cwd, payload);
      ensureAgentBootstrap(cwd, sessionCtx, briefing, payload);

      // Stage-2 sentinel: written once per agent home. Future starts short-
      // circuit the expensive integrate path on its presence.
      markWorkspaceInitComplete(cwd);

      sessionCtx.log(
        `Starting session (${claudeSessionId}), cwd=${cwd}, permissionMode=${config.permissionMode ?? "bypassPermissions"}`,
      );
      // Convert + stash BEFORE spawning the consumer loop. The consumer
      // may race to first iteration before the post-spawn push lands —
      // and if a wrapped stream-API error fires before we've stashed,
      // the retry path's `respawnQuery` would have nothing to replay
      // into the rebuilt InputController. See the
      // `claude-code-stream-error-retry-replay.test.ts` regression.
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, claudeSessionId);
      stashedSdkMessage = sdkMsg;
      spawnQuery(claudeSessionId, sessionCtx);
      inputController?.push(sdkMsg);
      pushPendingAckMessage(message, sessionCtx);
      scheduleInjectedMessagesDrain(sessionCtx, claudeSessionId);

      sessionCtx.log(`Session started (${claudeSessionId})`);
      return claudeSessionId;
    },

    async resume(message, sessionId, sessionCtx) {
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
        // Intentionally NOT calling ensureAgentBootstrap / prepareSourceRepos /
        // markWorkspaceInitComplete here — those write the new
        // `.first-tree-workspace/` agent-home layout, which would pollute the
        // legacy chat dir's v1.x `.agent/` and `<localPath>/` source repos.
        //
        // We DO refresh the briefing (writeAgentBriefing only touches the
        // AGENTS.md file + CLAUDE.md symlink, not `.first-tree-workspace/`,
        // the legacy `.agent/`, or source repos) because under the
        // unified-briefing redesign the SDK no longer has a
        // `systemPrompt.append` path — without this rewrite a legacy resume
        // would only see the stale v1.x stable CLAUDE.md, dropping the
        // current `prompt.append`, resource-skill briefing, and Current Chat
        // Context the previous per-turn SDK append used to deliver.
        // `sourceReposForPrompt` stays `[]` here on purpose: we don't run
        // `prepareSourceRepos` against the legacy cwd, so the briefing's
        // Source Repositories section is omitted for legacy resumes. The
        // agent still finds the v1.x checkouts at their original `<localPath>/`
        // — just without a top-level enumeration in the prompt.
        writeAgentBriefing(legacyCwd, currentBriefing(sessionCtx, legacyCwd, payload));
        // Same convert-stash-then-spawn ordering as `start()` so a stream
        // error fired on the first turn of the resumed session can replay
        // through `respawnQuery`.
        let sdkMsg: SDKUserMessage | null = null;
        if (message) {
          sdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
          stashedSdkMessage = sdkMsg;
        }
        spawnQuery(sessionId, sessionCtx, sessionId);
        if (sdkMsg) {
          inputController?.push(sdkMsg);
          if (message) pushPendingAckMessage(message, sessionCtx);
        }
        scheduleInjectedMessagesDrain(sessionCtx, sessionId);
        sessionCtx.log(`Session resumed at legacy cwd (${sessionId})`);
        return sessionId;
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
      await prepareSourceRepos(cwd, payload, sessionCtx);
      await materializeResourceSkills(cwd, payload, sessionCtx);

      const briefing = currentBriefing(sessionCtx, cwd, payload);
      ensureAgentBootstrap(cwd, sessionCtx, briefing, payload);

      markWorkspaceInitComplete(cwd);

      // Defensive fallback: sessionId isn't recognised at EITHER cwd (likely
      // a stale registry entry from machine swap / fs cleanup / tampering).
      // Report typed resume-unavailable to SessionManager. The manager owns
      // explicit provider session replacement; tree/CLI/bootstrap drift must
      // not silently mint a fresh id inside handler.resume().
      if (!claudeSessionFileExists(cwd, sessionId)) {
        throw new ResumeUnavailableError(
          "transcript_missing",
          `SDK transcript for ${sessionId} not found at legacy cwd (${legacyCwd}) or agent home (${cwd})`,
        );
      }

      sessionCtx.log(`Resuming session (${sessionId}), cwd=${cwd}`);
      let resumeSdkMsg: SDKUserMessage | null = null;
      if (message) {
        resumeSdkMsg = await toSDKUserMessage(message, sessionCtx, sessionId);
        stashedSdkMessage = resumeSdkMsg;
      }
      spawnQuery(sessionId, sessionCtx, sessionId);
      if (resumeSdkMsg) {
        inputController?.push(resumeSdkMsg);
        if (message) pushPendingAckMessage(message, sessionCtx);
      }
      scheduleInjectedMessagesDrain(sessionCtx, sessionId);

      sessionCtx.log(`Session resumed (${sessionId})`);
      return sessionId;
    },

    inject(message) {
      if (!claudeSessionId || !ctx) {
        ctx?.log("inject() called but no active session — dropping message");
        return;
      }
      const sessionCtx = ctx;
      const sid = claudeSessionId;
      queuedInjectedMessages.push(message);
      scheduleInjectedMessagesDrain(sessionCtx, sid);
    },

    async suspend() {
      ctx?.log("Suspending session");

      if (inputController) {
        inputController.end();
        inputController = null;
      }

      if (currentQuery) {
        currentQuery.close();
        currentQuery = null;
      }

      // Wait for consumer loop to finish
      if (consumerDone) {
        await consumerDone.catch(() => {});
        consumerDone = null;
      }

      abortController = null;
      // The session is no longer active — any pending replay message would
      // be moot. Resume goes through `handler.resume(message, sessionId)`
      // which re-stashes from its own argument.
      stashedSdkMessage = null;
      queuedInjectedMessages.length = 0;
      pendingAckMessages.length = 0;
      injectDrainInProgress = false;
    },

    async shutdown() {
      const sessionCtx = ctx;
      await handler.suspend();
      // Per agent-session-cwd-redesign: cwd is the per-agent home — shared
      // by every chat. shutdown() of ONE chat must NOT remove it (would
      // wipe persistent state and worktrees other chats are using). The
      // legacy `rmSync(cwd)` is therefore deleted.
      //
      // Source repos materialised by `prepareSourceRepos` are agent-scoped
      // shared resources, so we also no longer call cleanupGitWorktrees on
      // shutdown — those checkouts are explicit operator-managed state (see
      // proposals/agent-session-cwd-redesign §⑤). On-demand worktrees the
      // agent itself created under `<cwd>/worktrees/<name>/` are also
      // intentionally left alone — the agent owns their lifecycle.
      if (sessionCtx) await cleanupGitWorktrees(sessionCtx);
      cwd = null;
    },
  };

  return handler;
};
