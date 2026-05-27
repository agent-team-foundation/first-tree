import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanUseTool,
  McpServerConfig,
  PermissionMode,
  PermissionResult,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntimeConfigPayload, SessionEvent, SupportedImageMime } from "@first-tree/shared";
import { deriveRepoLocalPath, SUPPORTED_IMAGE_MIMES as SHARED_SUPPORTED_IMAGE_MIMES } from "@first-tree/shared";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import {
  bootstrapWorkspace,
  buildChatSystemPrompt,
  deepEqualIdentity,
  installFirstTreeIntegration,
  isHubWorktreeMarker,
  type PredeclaredSourceRepo,
  readCachedContextTreeHead,
  readContextTreeHead,
  writeContextTreeHead,
} from "../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../runtime/chat-context.js";
import { resolveGitRepoTargetPath } from "../runtime/git-local-path.js";
import { deriveSessionBranchName, type GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type {
  AgentHandler,
  AgentIdentity,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../runtime/handler.js";
import { findImagePath } from "../runtime/image-store.js";
import { InputController } from "../runtime/input-controller.js";
import { acquireAgentHome, INIT_COMPLETE_SENTINEL_REL, markWorkspaceInitComplete } from "../runtime/workspace.js";
import { withWorktreePathLock } from "../runtime/worktree-mutex.js";
import { resolveClaudeCodeExecutable } from "./claude-executable.js";

const MAX_RETRIES = 2;

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

/** Post-refactor image message shape in `messages.content`: a reference only.
 * The bytes arrive via the separate `image_payload` WS push and live on
 * this client's local disk under `<dataDir>/chats/<chatId>/images/`. */
type ImageRefContent = {
  imageId: string;
  mimeType: SupportedImageMime;
  filename: string;
  size?: number;
};

function isImageRefContent(content: unknown): content is ImageRefContent {
  if (!content || typeof content !== "object") return false;
  const c = content as Record<string, unknown>;
  return (
    typeof c.imageId === "string" &&
    typeof c.mimeType === "string" &&
    typeof c.filename === "string" &&
    SUPPORTED_IMAGE_MIMES.has(c.mimeType as SupportedImageMime)
  );
}

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
 * tool can pick it up. Only the legacy path — new messages go through the
 * image_payload WS push which pre-writes to the data dir before delivery.
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
};

function isResultMessage(message: unknown): message is ResultMessage {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return m.type === "result" && typeof m.subtype === "string";
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
 * View tools whose `file_path` argument names a single file the model is
 * reading. A read of a file under the Context Tree root is the honest
 * "agent consulted the tree" signal (see `treeNodePathOf`). Search tools
 * (Grep/Glob) are excluded — they scan, they don't read a specific node.
 */
const TREE_READ_TOOL_NAMES: ReadonlySet<string> = new Set(["Read", "NotebookRead"]);

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

/**
 * If a tool with this name + input is a tree-file read, return the node path
 * it read; else null.
 */
function treeReadNodePath(toolName: string, input: unknown, contextTreePath: string): string | null {
  if (!TREE_READ_TOOL_NAMES.has(toolName)) return null;
  const filePath = readFilePathArg(input);
  if (filePath === null) return null;
  return treeNodePathOf(filePath, contextTreePath);
}

/** Context Tree binding the tool-call processor needs to emit usage signals. */
export type ContextTreeBinding = { path: string | null; repoUrl: string | null };

/**
 * Pair `tool_use` (assistant) with `tool_result` (user) blocks and emit a
 * `tool_call` event per pair. Unpaired entries are flushed as `status: "pending"`.
 *
 * When a `contextTree` binding is supplied, a view tool whose read of a file
 * under the tree root SUCCEEDS ALSO emits a `context_tree_usage` event carrying
 * the node path — the honest replacement for the old per-inbound-message emit.
 * Emitting on the successful tool_result (not the tool_use request) means
 * failed/aborted reads never inflate the signal.
 */
export type ToolCallProcessor = {
  onMessage(message: unknown): void;
  flush(): void;
};

export function createToolCallProcessor(
  emit: (event: SessionEvent) => void,
  contextTree?: ContextTreeBinding,
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
    emit({
      kind: "tool_call",
      payload: {
        toolUseId: entry.toolUseId,
        name: entry.name,
        args: entry.args,
        status,
        durationMs,
        ...(resultPreview !== undefined ? { resultPreview } : {}),
      },
    });

    // Honest Context Tree usage: a view tool that successfully read a file
    // under the tree root means the agent actually consulted that node. Emit
    // here (on the successful tool_result), not on the tool_use request, so
    // failed reads (is_error) and aborted/unanswered reads never count.
    // Carries the node path so the web feed can show which node was read.
    // Replaces the old unconditional per-inbound-message emit (the vanity metric).
    if (status === "ok" && contextTree?.path) {
      const nodePath = treeReadNodePath(entry.name, entry.args, contextTree.path);
      if (nodePath !== null) {
        emit({
          kind: "context_tree_usage",
          payload: { purpose: "design_decision", treeRepoUrl: contextTree.repoUrl, nodePath },
        });
      }
    }

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
  /** Worktrees materialised for this session — each entry removed on shutdown. */
  const ownedWorktrees: Array<{ url: string; path: string; branchName: string }> = [];
  /**
   * Latest chat-context snapshot for the active session. Used to build the
   * per-turn system-prompt block injected via `systemPrompt.append`. Cleared
   * when the session ends or `start()` runs for a fresh session.
   */
  let chatContextForPrompt: ChatContext | undefined;
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
   * — those are runtime-opaque (created by the agent, not by Hub).
   */
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];

  async function toSDKUserMessage(
    message: SessionMessage,
    sessionCtx: SessionContext,
    sessionId: string,
  ): Promise<SDKUserMessage> {
    // Image messages — two supported shapes:
    //   1. imageRef: `{imageId, mimeType, filename, size}` — new path. Bytes
    //      live on local disk, delivered via the `image_payload` WS push.
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
        // Bytes never reached this client (offline during the image_payload
        // push, or sending server lived on another instance). Treat as the
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
   * Code specific) then let the runtime layer add the Agent-Hub envelope via
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
    // BEFORE Hub-internal vars so the latter wins on collision.
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
  function spawnQuery(sessionId: string, sessionCtx: SessionContext, resume?: string, chatContext?: ChatContext): void {
    // Stash the chat-context so respawn (config hot-switch retry) keeps it
    // available without the caller having to thread it through again.
    if (chatContext !== undefined) {
      chatContextForPrompt = chatContext;
    }
    buildQuery(sessionId, sessionCtx, resume);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
  }

  /**
   * Build the SDK `canUseTool` callback. Auto-allows every tool except
   * `AskUserQuestion`, which is no longer bridged: NHA M0 strips the
   * question mechanism end-to-end. The replacement deny redirects the
   * agent at the Need-Human-Attention CLI / SDK so it can request human
   * attention through the new surface.
   */
  function buildAskUserCanUseTool(sessionCtx: SessionContext): CanUseTool {
    return async (toolName, input, _options) => {
      if (toolName === "AskUserQuestion") {
        sessionCtx.log("AskUserQuestion is no longer bridged; redirecting agent to NHA");
        return {
          behavior: "deny",
          message:
            "AskUserQuestion is no longer supported in this Hub. " +
            "To request human attention, use the `first-tree attention raise` CLI (or your runtime's NHA SDK). " +
            "See the `attention` skill for usage.",
        } satisfies PermissionResult;
      }
      return { behavior: "allow", updatedInput: input };
    };
  }

  /** Rebuild query and input controller without starting a new consumer loop (used for retry within the existing loop). */
  function respawnQuery(sessionId: string, sessionCtx: SessionContext): void {
    buildQuery(sessionId, sessionCtx, sessionId);
    // retry keeps the same config — applied* unchanged.
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

    // Compose `systemPrompt.append`: agent-config-managed append (Hub) +
    // per-chat block (built from the latest chatContext + predeclared
    // worktrees). The SDK only accepts a single string here, so we
    // concatenate with a blank-line separator. Either piece may be empty;
    // the systemPrompt option is omitted entirely if the combined string
    // is empty so we don't change SDK behavior for callers that never had
    // a Hub-managed append.
    const agentConfigAppend = payload?.prompt.append?.trim() ?? "";
    const perChatAppend = cwd
      ? buildChatSystemPrompt({
          agentHome: cwd,
          chatContext: chatContextForPrompt,
          sourceRepos: sourceReposForPrompt,
        }).trim()
      : "";
    const combinedAppend = [agentConfigAppend, perChatAppend].filter((s) => s.length > 0).join("\n\n");

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
        //   - `project` loads the workspace CLAUDE.md generated by bootstrap
        //     (agent identity + Agent Hub SDK usage + tools reference).
        //   - `user` inherits the operator's local `~/.claude/settings.json`
        //     so their Claude Code customizations (thinking mode, effortLevel,
        //     outputStyle, statusLine, plugins, skills, hooks, MCP servers)
        //     carry over to agent sessions on their machine. Hub-managed
        //     fields (model, systemPrompt, env, permissionMode, and the Hub
        //     `mcpServers` list) still win because they are passed as
        //     explicit SDK options below, which layer on top of settings.
        settingSources: ["user", "project"],
        env: buildEnv(sessionCtx),
        // NHA M0: AskUserQuestion is denied with a redirect message; all
        // other tools auto-allow. See buildAskUserCanUseTool.
        canUseTool: buildAskUserCanUseTool(sessionCtx),
        ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
        ...(payload?.model ? { model: payload.model } : {}),
        ...(combinedAppend.length > 0
          ? { systemPrompt: { type: "preset", preset: "claude_code", append: combinedAppend } }
          : {}),
        ...(payload?.mcpServers.length ? { mcpServers: mapMcpServers(payload) } : {}),
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
    const toolCallProcessor = createToolCallProcessor((event) => sessionCtx.emitEvent(event), {
      path: contextTreePath,
      repoUrl: contextTreeRepoUrl,
    });
    try {
      while (true) {
        if (!currentQuery) return;

        try {
          sessionCtx.setRuntimeState("working");

          for await (const message of currentQuery) {
            // Every message refreshes lastActivity to prevent idle timeout
            sessionCtx.touch();

            toolCallProcessor.onMessage(message);

            if (isResultMessage(message)) {
              if (message.subtype === "success") {
                retryCount = 0;
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
                  try {
                    // All enrichment (inReplyTo, mentions, participants
                    // lookup, transport) lives in ctx.forwardResult so every
                    // handler shares one code path — see runtime/result-sink.ts.
                    await sessionCtx.forwardResult(resultText);
                    sessionCtx.log("Result forwarded to chat");
                    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
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
                  }
                } else {
                  // No result text to forward (edge case) — still close the turn.
                  sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "success" } });
                }
              } else {
                const errors = message.errors ? message.errors.join("; ") : message.subtype;
                const errorLog = `Query result error: ${errors} (subtype=${message.subtype}, turns=${message.num_turns ?? "?"}, duration=${message.duration_ms ?? "?"}ms)`;
                sessionCtx.log(errorLog);
                sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: errors } });
                sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
              }
              sessionCtx.setRuntimeState("idle");
            }
          }
          sessionCtx.setRuntimeState("idle");
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
            // short-circuit the `setRuntimeState("error")` call below —
            // if that one is skipped the SessionManager keeps the slot
            // counted as `working` and never reclaims it.
            try {
              const preview = errMsg.slice(0, 800);
              const reason = claudeSessionId
                ? `Query failed after ${MAX_RETRIES} retries: ${preview}`
                : `Query failed and no resume id available: ${preview}`;
              sessionCtx.emitEvent({ kind: "error", payload: { source: "runtime", message: reason } });
              sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
            } catch (emitErr) {
              sessionCtx.log(
                `Failed to emit retry-exhaustion error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
              );
            }
            sessionCtx.setRuntimeState("error");
            return;
          }

          // Automatic retry — respawn query and continue loop. Flush any
          // tool_use blocks that were in-flight when the session crashed so
          // the admin event stream sees them as status:"pending" rather than
          // getting paired against a replayed tool_use_id after resume.
          toolCallProcessor.flush();

          retryCount++;
          sessionCtx.log(`Attempting auto-resume (retry ${retryCount}/${MAX_RETRIES})`);
          try {
            respawnQuery(claudeSessionId, sessionCtx);
          } catch (resumeErr) {
            const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
            sessionCtx.log(`Auto-resume failed: ${resumeMsg}`);
            // Mirror the MAX_RETRIES branch above: leaving runtimeState at
            // `working` would block the SessionManager's idle-suspend grace
            // window from ever firing on this session, so the slot would
            // never be reclaimed. Wrap the emits defensively so the
            // setRuntimeState call still runs if the callback throws.
            try {
              sessionCtx.emitEvent({
                kind: "error",
                payload: { source: "runtime", message: `Auto-resume failed: ${resumeMsg.slice(0, 800)}` },
              });
              sessionCtx.emitEvent({ kind: "turn_end", payload: { status: "error" } });
            } catch (emitErr) {
              sessionCtx.log(
                `Failed to emit auto-resume error event: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
              );
            }
            sessionCtx.setRuntimeState("error");
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
  // `agentName` is the operator-chosen stable identifier (`config.yaml`'s
  // `agents.<name>` key). Used as `--workspace-id` for first-tree integrate
  // so a single agent's multi-chat workspaces all bind to the same skill
  // workspace identity instead of churning a new id per chat.
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
   * bare mirror + creates the working tree; subsequent calls fetch (so the
   * bare mirror picks up upstream changes) and reuse the existing checkout
   * in place — no reset, so any pending state the LLM left behind survives.
   *
   * Concurrency: per-process per-path mutex (`withWorktreePathLock`) so two
   * sessions starting at the same time don't race `git worktree add` for the
   * same path. See proposals/agent-session-cwd-redesign.20260519.md §⑧ R1.
   *
   * Side effect: refreshes `sourceReposForPrompt` so the per-turn system-
   * prompt block (`buildChatSystemPrompt`) can list absolute paths +
   * upstream coordinates for the LLM.
   *
   * Fail-fast semantics per PRD D10/D13/D14: any failure aborts the session
   * and the error bubbles up to the caller (SessionManager).
   */
  async function prepareSourceRepos(
    workspace: string,
    payload: AgentRuntimeConfigPayload | undefined,
    sessionCtx: SessionContext,
  ): Promise<void> {
    // Reset the prompt-facing list. If `gitRepos` is empty (or the manager
    // isn't wired up), the agent simply gets no source-repos section.
    sourceReposForPrompt = [];

    if (!gitMirrorManager || !payload?.gitRepos?.length) return;

    for (const repo of payload.gitRepos) {
      const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
      // Source repos live at the TOP LEVEL of the agent home — no
      // `worktrees/` prefix. The `worktrees/` subdir is reserved for the
      // agent's on-demand worktrees.
      const targetPath = resolveGitRepoTargetPath(workspace, localPath);
      sessionCtx.log(`Git: preparing source repo ${repo.url} → ${localPath}${repo.ref ? ` @ ${repo.ref}` : ""}`);

      // D14: ensureMirror is idempotent — clone once, fast return thereafter.
      const mirror = await gitMirrorManager.ensureMirror(repo.url);
      if (mirror.cloned) {
        sessionCtx.log(`Git: cloned ${repo.url} in ${mirror.elapsedMs}ms`);
      }

      // D10: fresh fetch on every new dialog. Failure aborts session creation.
      await gitMirrorManager.fetchMirror(repo.url);

      const branchAgentKey = agentName ?? sessionCtx.agent.agentId;

      // Serialise per absolute path so two concurrent sessions for the same
      // agent can't both try to create the same checkout.
      const { branchName } = await withWorktreePathLock(targetPath, async () => {
        if (existsSync(targetPath)) {
          if (isHubWorktreeMarker(targetPath)) {
            sessionCtx.log(`Git: reusing existing source repo at ${localPath}`);
            // Reuse path: branchName is deterministic for cleanup. With the
            // per-agent shared-checkout model, sessionKey is the agentName
            // (not chatId) so a checkout created by chat A is reused by
            // chat B without forking branches.
            return {
              branchName: deriveSessionBranchName(branchAgentKey, branchAgentKey, repo.url),
              headCommit: null as string | null,
            };
          }
          // Path occupied by a non-Hub directory (operator placed it, leftover
          // from an old layout, etc). Log it explicitly — `createWorktree`
          // below will likely fail with a generic "path exists" error, and
          // without this line the operator has no way to know why. PR #506
          // review S1.
          sessionCtx.log(
            `Git: source-repo target ${localPath} occupied by a non-Hub directory; ` +
              "createWorktree will likely fail — move or remove the directory and re-run",
          );
        }
        const created = await gitMirrorManager.createWorktree({
          url: repo.url,
          ref: repo.ref,
          targetPath,
          // sessionKey identifies the branch *owner*. In the per-agent-home
          // model the owner is the agent, not the chat.
          sessionKey: branchAgentKey,
          agentName: branchAgentKey,
        });
        return { branchName: created.branchName, headCommit: created.headCommit as string | null };
      });

      // Per agent-session-cwd-redesign: predeclared source repos are agent-
      // scoped persistent resources. They survive shutdown so the next chat
      // finds them ready. We therefore do NOT track them in `ownedWorktrees`
      // (the legacy shutdown-cleanup list).

      sourceReposForPrompt.push({
        absolutePath: targetPath,
        url: repo.url,
        ...(repo.ref ? { ref: repo.ref } : {}),
        branch: branchName,
      });

      sessionCtx.log(`Git: source repo at ${localPath} on ${branchName}`);
    }
  }

  /** Tear down all worktrees this session owns; best-effort. */
  async function cleanupGitWorktrees(sessionCtx: SessionContext): Promise<void> {
    if (!gitMirrorManager) return;
    while (ownedWorktrees.length > 0) {
      const entry = ownedWorktrees.pop();
      if (!entry) continue;
      try {
        await gitMirrorManager.removeWorktree(entry);
      } catch (err) {
        sessionCtx.log(
          `Git: removeWorktree(${entry.path}) failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Best-effort chat-context fetch for the identity-injection path. Failures
   * are logged but never bubble — bootstrap continues with `undefined` and
   * the agent simply loses the "Current Chat Context" block (graceful
   * degradation; the Communication Rules in tools.md still tell it to fall
   * back to conservative mode).
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
   * Hash-check the existing identity.json against the current agent metadata
   * and rewrite it (plus the rest of the .agent/ stable section) only when
   * something changed. Cheap to run on every session start — the typical
   * path is a single readFileSync + JSON.parse + memcmp.
   *
   * R5 in the proposal: agent rename / inboxId change / metadata edits must
   * still propagate even after the sentinel is set, so this runs OUT of the
   * sentinel gate.
   */
  function ensureStableIdentity(workspace: string, sessionCtx: SessionContext): void {
    const identityPath = join(workspace, ".agent", "identity.json");
    const desired = {
      agentId: sessionCtx.agent.agentId,
      displayName: sessionCtx.agent.displayName,
      type: sessionCtx.agent.type,
      delegateMention: sessionCtx.agent.delegateMention,
      metadata: sessionCtx.agent.metadata,
      serverUrl: sessionCtx.sdk.serverUrl,
      contextTreePath,
    };
    if (existsSync(identityPath)) {
      try {
        const current = JSON.parse(readFileSync(identityPath, "utf-8"));
        if (deepEqualIdentity(current, desired)) return;
      } catch {
        // Corrupt JSON — fall through to rewrite via bootstrapWorkspace.
      }
    }
    // Mismatch (or missing / corrupt) — re-run the full stable bootstrap so
    // context/, tools.md, the boundary marker, and identity.json all line up
    // with the current agent metadata. Cheap relative to integrate / git.
    bootstrapWorkspace({
      workspacePath: workspace,
      identity: sessionCtx.agent,
      contextTreePath,
      serverUrl: sessionCtx.sdk.serverUrl,
    });
    generateStableClaudeMd(workspace, sessionCtx.agent, contextTreePath);
  }

  /**
   * Run the expensive first-time bootstrap (full stable layout + `first-tree
   * tree integrate` shell-out). Gated by the stage-2 sentinel + Context-Tree
   * HEAD drift detection (proposals/agent-session-cwd-redesign §⑤.3):
   *
   *   - Sentinel absent → full bootstrap.
   *   - Sentinel present + Tree HEAD unchanged → cheap identity refresh only.
   *   - Sentinel present + Tree HEAD drifted → full bootstrap re-runs so the
   *     stable CLAUDE.md and first-tree skill pick up the new tree state.
   *
   * `workspaceId` for the integrate shell-out is the agent name — the home
   * directory is per-agent, so the skill identity stays stable across chats.
   */
  function ensureAgentBootstrap(workspace: string, sessionCtx: SessionContext): void {
    const sentinelPresent = existsSync(join(workspace, INIT_COMPLETE_SENTINEL_REL));
    const currentTreeHead = readContextTreeHead(contextTreePath);
    const cachedTreeHead = readCachedContextTreeHead(workspace);
    // Only treat as drift when we know both values AND they differ — `null`
    // on either side means "we don't know", in which case we fall back to
    // the sentinel-only decision (fail open). Warn when the asymmetry shows
    // up so a transient `git rev-parse` failure doesn't silently disable
    // drift detection (PR #506 review Q1).
    if (cachedTreeHead !== null && currentTreeHead === null) {
      sessionCtx.log(
        `Context Tree HEAD probe returned null while cached value is ` +
          `${cachedTreeHead.slice(0, 7)}; drift detection bypassed for this start`,
      );
    }
    const treeDrifted = currentTreeHead !== null && cachedTreeHead !== null && currentTreeHead !== cachedTreeHead;

    if (sentinelPresent && !treeDrifted) {
      ensureStableIdentity(workspace, sessionCtx);
      return;
    }

    if (sentinelPresent && treeDrifted) {
      sessionCtx.log(
        `Context Tree HEAD changed (${cachedTreeHead?.slice(0, 7)} → ${currentTreeHead?.slice(0, 7)}); re-running bootstrap`,
      );
    }

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: sessionCtx.agent,
      contextTreePath,
      serverUrl: sessionCtx.sdk.serverUrl,
    });
    generateStableClaudeMd(workspace, sessionCtx.agent, contextTreePath);

    if (contextTreePath) {
      installFirstTreeIntegration({
        workspacePath: workspace,
        contextTreePath,
        workspaceId: agentName ?? sessionCtx.agent.agentId,
        treeRepoUrl: contextTreeRepoUrl ?? undefined,
        log: (msg) => sessionCtx.log(msg),
      });
    }

    // Pin the current HEAD so the next start can detect drift.
    writeContextTreeHead(workspace, currentTreeHead);
  }

  const handler: AgentHandler = {
    async start(message, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = randomUUID();
      // Per agent-session-cwd-redesign: cwd is per-agent, shared by every
      // chat session. acquireAgentHome creates the directory and writes the
      // boundary marker on first call; afterwards it is a no-op.
      cwd = acquireAgentHome(workspaceRoot);

      // Fetch chat-context for per-turn prompt injection (Step 4 wires it).
      const chatContext = await fetchChatContextOrLog(sessionCtx);
      ensureAgentBootstrap(cwd, sessionCtx);

      // Materialise gitRepos under `<cwd>/worktrees/<name>` before the
      // child process starts. Failures here abort session creation (D10/D13).
      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      await prepareSourceRepos(cwd, payload, sessionCtx);

      // Stage-2 sentinel: written once per agent home. Future starts short-
      // circuit the expensive integrate path on its presence.
      markWorkspaceInitComplete(cwd);

      sessionCtx.log(
        `Starting session (${claudeSessionId}), cwd=${cwd}, permissionMode=${config.permissionMode ?? "bypassPermissions"}`,
      );
      spawnQuery(claudeSessionId, sessionCtx, undefined, chatContext);
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, claudeSessionId);
      inputController?.push(sdkMsg);

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
      // every piece of agent-home setup (the legacy dir already has its
      // own `.agent/`, CLAUDE.md, and gitRepos checkout at top-level).
      const legacyCwd = join(workspaceRoot, sessionCtx.chatId);
      const isLegacy = existsSync(legacyCwd) && claudeSessionFileExists(legacyCwd, sessionId);

      if (isLegacy) {
        cwd = legacyCwd;
        sessionCtx.log(
          `Resume: detected pre-redesign SDK transcript at legacy cwd ${legacyCwd}; ` +
            "running this session under the legacy per-chat layout to preserve agent memory",
        );
        const chatContext = await fetchChatContextOrLog(sessionCtx);
        // Intentionally NOT calling ensureAgentBootstrap / prepareSourceRepos /
        // markWorkspaceInitComplete here — those write the new agent-home
        // layout, which would pollute the legacy chat dir. The dir already
        // carries the v1.x bootstrap output (CLAUDE.md, AGENTS.md, .agent/,
        // <localPath>/ source repos), and the agent reads it via the SDK's
        // `settingSources: ["project"]` option.
        spawnQuery(sessionId, sessionCtx, sessionId, chatContext);
        if (message) {
          inputController?.push(await toSDKUserMessage(message, sessionCtx, sessionId));
        }
        sessionCtx.log(`Session resumed at legacy cwd (${sessionId})`);
        return sessionId;
      }

      // Normal new-design resume path: cwd is the agent home.
      cwd = acquireAgentHome(workspaceRoot);

      // Identical control flow to start(): bootstrap is idempotent and the
      // sentinel gates the expensive integrate. The cheap stable-identity
      // hash check runs every time so agent rename / inboxId changes
      // propagate even after the sentinel is set (R5 in the proposal).
      const chatContext = await fetchChatContextOrLog(sessionCtx);
      ensureAgentBootstrap(cwd, sessionCtx);

      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      await prepareSourceRepos(cwd, payload, sessionCtx);

      markWorkspaceInitComplete(cwd);

      // Defensive fallback: sessionId isn't recognised at EITHER cwd (likely
      // a stale registry entry from machine swap / fs cleanup / tampering).
      // Mint a fresh id and start cold — Hub message history survives.
      if (!claudeSessionFileExists(cwd, sessionId)) {
        const freshSessionId = randomUUID();
        sessionCtx.log(
          `Resume: SDK transcript for ${sessionId} not found at legacy (${legacyCwd}) ` +
            `or agent home (${cwd}); starting fresh session ${freshSessionId} — ` +
            "Hub message history is preserved.",
        );
        claudeSessionId = freshSessionId;
        spawnQuery(freshSessionId, sessionCtx, undefined, chatContext);
        if (message) {
          inputController?.push(await toSDKUserMessage(message, sessionCtx, freshSessionId));
        }
        sessionCtx.log(`Session started (${freshSessionId}, replacing ${sessionId})`);
        return freshSessionId;
      }

      sessionCtx.log(`Resuming session (${sessionId}), cwd=${cwd}`);
      spawnQuery(sessionId, sessionCtx, sessionId, chatContext);
      if (message) {
        inputController?.push(await toSDKUserMessage(message, sessionCtx, sessionId));
      }

      sessionCtx.log(`Session resumed (${sessionId})`);
      return sessionId;
    },

    inject(message) {
      if (!inputController || !claudeSessionId || !ctx) {
        ctx?.log("inject() called but no active session — dropping message");
        return;
      }
      const sessionCtx = ctx;
      const sid = claudeSessionId;
      // Step 6: switch (in-flight or restart) BEFORE injecting if the cached
      // config is newer than the one we launched with. Errors are logged
      // and we still deliver against the existing query — better than
      // dropping the user message.
      void maybeSwitchConfig(sessionCtx)
        .catch((err) => {
          sessionCtx.log(`maybeSwitchConfig errored: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(async () => {
          try {
            const sdkMsg = await toSDKUserMessage(message, sessionCtx, sid);
            inputController?.push(sdkMsg);
          } catch (err) {
            sessionCtx.log(`toSDKUserMessage errored: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
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

/**
 * Generate a CLAUDE.md file from .agent/ bootstrap data.
 *
 * Layer 1 (always): Agent identity (from Hub)
 * Layer 2 (if Context Tree configured): Operating instructions + domain map
 * Layer 3 (if Context Tree configured): Context Tree location for on-demand reading
 *
 * Per PRD D7 the agent's behavior instructions live in Hub-managed
 * `agent_configs.payload.prompt.append` and are passed to the Claude SDK via
 * `systemPrompt.append` — not through this file.
 */
/**
 * Generate the **stable** CLAUDE.md materialised at the agent home root.
 *
 * Per agent-session-cwd-redesign: this file contains only agent-level
 * content (identity, org domain map, Context Tree pointer, SDK tools). Per-
 * chat content — Current Chat Context, participants — is injected per turn
 * via the SDK's `appendSystemPrompt` so two concurrent chats sharing this
 * cwd never see each other's data on disk.
 *
 * Per PRD D7 the agent's behavior instructions live in Hub-managed
 * `agent_configs.payload.prompt.append` and are passed to the Claude SDK via
 * `systemPrompt.append` — not through this file.
 */
function generateStableClaudeMd(workspacePath: string, identity: AgentIdentity, contextTreePath: string | null): void {
  const sections: string[] = [];
  const contextDir = join(workspacePath, ".agent", "context");

  // --- Identity ---
  // Post-type-merge (migration 0051): pre-merge `personal_assistant` and
  // `autonomous_agent` collapsed into a single `agent` row. The "personal
  // assistant" vs. "autonomous bot" framing is now carried by
  // `agents.visibility` (private → personal assistant, organization →
  // autonomous bot). Do NOT infer from `delegateMention` — only `human`
  // rows can hold a delegate, so every `agent` row's `delegateMention`
  // is null and that signal is useless for this distinction.
  const name = identity.displayName ?? identity.agentId;
  if (identity.visibility === "private") {
    sections.push(`# Agent Identity\n\nYou are ${name}, a personal assistant agent.\n`);
  } else {
    sections.push(`# Agent Identity\n\nYou are ${name}, an autonomous agent.\n`);
  }

  // --- Context Tree operating instructions (AGENT.md) ---
  const agentInstructionsPath = join(contextDir, "agent-instructions.md");
  if (existsSync(agentInstructionsPath)) {
    const instructions = readFileSync(agentInstructionsPath, "utf-8");
    sections.push(`## Operating Instructions\n\n${instructions}\n`);
  }

  // --- Organization domain map (root NODE.md) ---
  const domainMapPath = join(contextDir, "domain-map.md");
  if (existsSync(domainMapPath)) {
    const domainMap = readFileSync(domainMapPath, "utf-8");
    sections.push(`## Organization Domain Map\n\n${domainMap}\n`);
  }

  // --- Context Tree location for on-demand reading ---
  if (contextTreePath) {
    sections.push(
      `## Context Tree Location\n\nThe full Context Tree is available at: \`${contextTreePath}\`\n\nRead specific domain nodes as needed following the operating instructions above.\n`,
    );
  }

  // --- SDK tools reference ---
  const toolsPath = join(workspacePath, ".agent", "tools.md");
  if (existsSync(toolsPath)) {
    const toolsContent = readFileSync(toolsPath, "utf-8");
    sections.push(toolsContent);
  }

  writeFileSync(join(workspacePath, "CLAUDE.md"), sections.join("\n"), "utf-8");
}
