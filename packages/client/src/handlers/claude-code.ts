import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentRuntimeConfigPayload,
  SessionEvent,
  SupportedImageMime,
} from "@agent-team-foundation/first-tree-hub-shared";
import {
  deriveRepoLocalPath,
  type QuestionItem,
  type QuestionMessageContent,
  questionItemSchema,
  SUPPORTED_IMAGE_MIMES as SHARED_SUPPORTED_IMAGE_MIMES,
} from "@agent-team-foundation/first-tree-hub-shared";
import type {
  CanUseTool,
  McpServerConfig,
  PermissionMode,
  PermissionResult,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { bootstrapWorkspace, installFirstTreeIntegration } from "../runtime/bootstrap.js";
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
import { acquireWorkspace } from "../runtime/workspace.js";
import { clearPendingForAgent, registerPendingQuestion, rejectPendingForAgent } from "./ask-user-bridge.js";
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
  const dir = join(tmpdir(), "first-tree-hub", "images", sanitizeChatId(chatId));
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
 * Pair `tool_use` (assistant) with `tool_result` (user) blocks and emit a
 * `tool_call` event per pair. Unpaired entries are flushed as `status: "pending"`.
 */
export type ToolCallProcessor = {
  onMessage(message: unknown): void;
  flush(): void;
};

export function createToolCallProcessor(emit: (event: SessionEvent) => void): ToolCallProcessor {
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

    // Child processes receive the member access JWT as FIRST_TREE_HUB_ACCESS_TOKEN
    // and pair it with X-Agent-Id (sent by the SDK automatically) to act as
    // the current agent. Obtaining the token at buildEnv-time means the child
    // sees the JWT valid at its spawn moment; long-lived runtimes should
    // re-spawn after refresh, or re-read the env on their own cadence.
    return sessionCtx.buildAgentEnv(env);
  }

  /** Create query and input controller, then start consumer loop. */
  function spawnQuery(sessionId: string, sessionCtx: SessionContext, resume?: string): void {
    buildQuery(sessionId, sessionCtx, resume);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
  }

  /**
   * Build the SDK `canUseTool` callback for this session. Auto-allows every
   * tool except `AskUserQuestion`, which we route through the Hub's inbox:
   *
   *   1. Validate the SDK's question shape against the shared Zod schema (so
   *      a malformed model output can't smuggle bad data into Hub messages).
   *   2. Send a `format: "question"` message via the agent SDK — this hits
   *      the server's `sendMessage` path which writes the `pending_questions`
   *      lifecycle row in the same transaction (see commit 2).
   *   3. Register a Promise keyed on the SDK `toolUseID`. The matching
   *      `question_answer` message arrives over the inbox WS / poll path
   *      and SessionManager.dispatch resolves the Promise (commit 2 wired
   *      the answer route + supersede hooks; SessionManager wiring lives
   *      in this commit).
   *   4. Map the bridge result to `PermissionResult`: `answered` →
   *      `{ behavior: "allow", updatedInput: { questions, answers } }`,
   *      `denied` → `{ behavior: "deny", message }` so the model abandons
   *      the call instead of looping.
   *
   * `bypassPermissions` mode still calls `canUseTool` for `AskUserQuestion`
   * specifically — verified by `tmp-verify/verify.mjs` cases A through G.
   */
  function buildAskUserCanUseTool(sessionCtx: SessionContext): CanUseTool {
    return async (toolName, input, options) => {
      if (toolName !== "AskUserQuestion") {
        return { behavior: "allow", updatedInput: input };
      }

      // Validate the question shape from the model. SDK 0.2.84 emits the
      // canonical AskUserQuestion input as `{ questions: QuestionItem[] }`;
      // anything else is a model regression that we deny outright.
      const inputSchema = z.object({ questions: z.array(questionItemSchema).min(1).max(4) });
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) {
        sessionCtx.log(`AskUserQuestion: malformed input — ${parsed.error.message.slice(0, 200)}`);
        return {
          behavior: "deny",
          message: "AskUserQuestion input did not validate; abandon the question and pick a different tool or answer.",
        } satisfies PermissionResult;
      }

      const correlationId = options.toolUseID;
      const questions: QuestionItem[] = parsed.data.questions;

      const questionContent: QuestionMessageContent = {
        correlationId,
        questions,
        previewFormat: "html",
        allowFreeText: true,
      };

      // Push the question into the inbox first. If the upstream send fails
      // we never register a pending entry — the SDK gets a clean deny and
      // the model can retry. Server-side codex defense (commit 2) returns
      // 403 for codex senders; we propagate that as a deny so the model
      // doesn't burn turns hitting the same wall.
      try {
        await sessionCtx.sdk.sendMessage(sessionCtx.chatId, {
          format: "question",
          content: questionContent,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        sessionCtx.log(`AskUserQuestion: failed to publish question — ${reason}`);
        return {
          behavior: "deny",
          message: `Hub could not publish the question (${reason}); abandon the call.`,
        } satisfies PermissionResult;
      }

      sessionCtx.log(`AskUserQuestion: published correlationId=${correlationId}; awaiting user answer`);

      // Wait for the matching question_answer to land in inbox. This Promise
      // can sit pending for arbitrarily long — `defer` handling on the SDK
      // hook side (PreToolUse) is the long-tail strategy if we ever need
      // process-resume; for v1, the WS push path keeps the latency tight.
      const result = await registerPendingQuestion({
        correlationId,
        agentId: sessionCtx.agent.agentId,
        chatId: sessionCtx.chatId,
      });

      if (options.signal.aborted) {
        // The query was aborted while we were waiting (eviction, restart,
        // hot-switch). The bridge entry has already been removed by
        // `rejectPendingForAgent`; just return a deny so the SDK unwinds.
        return {
          behavior: "deny",
          message: "AskUserQuestion aborted before an answer arrived.",
        } satisfies PermissionResult;
      }

      if (result.status === "denied") {
        sessionCtx.log(`AskUserQuestion: denied correlationId=${correlationId} reason=${result.reason}`);
        return { behavior: "deny", message: result.reason } satisfies PermissionResult;
      }

      sessionCtx.log(`AskUserQuestion: answered correlationId=${correlationId}`);
      return {
        behavior: "allow",
        updatedInput: { questions, answers: result.answers },
      } satisfies PermissionResult;
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
        // Bridge AskUserQuestion to the Hub's inbox round-trip. Other tools
        // are auto-allowed inside the bridge — `bypassPermissions` mode
        // already skips the SDK's own prompt for non-ask-user tools, so
        // adding canUseTool keeps existing behaviour while opening the
        // ask-user channel for the model.
        canUseTool: buildAskUserCanUseTool(sessionCtx),
        // Drive the model to emit web-renderable previews. The frontend
        // sanitises with DOMPurify before rendering (commit 5).
        toolConfig: { askUserQuestion: { previewFormat: "html" } },
        ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
        ...(payload?.model ? { model: payload.model } : {}),
        ...(payload?.prompt.append
          ? { systemPrompt: { type: "preset", preset: "claude_code", append: payload.prompt.append } }
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
    const toolCallProcessor = createToolCallProcessor((event) => sessionCtx.emitEvent(event));
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
                    sessionCtx.reportSessionCompletion();
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
            sessionCtx.log(`Auto-resume failed: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`);
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
   * Materialise the runtime config's `gitRepos` into worktrees under `cwd`.
   * Idempotent across resumes: reuses an existing Hub-managed worktree if
   * present, otherwise clones/fetches the bare mirror and creates a new
   * `--detach`'d worktree at `<cwd>/<localPath>` (PRD §5.1.5).
   *
   * Fail-fast semantics per PRD D10/D13/D14: any failure aborts the session
   * and the error bubbles up to the caller (SessionManager).
   */
  async function prepareGitWorktrees(
    workspace: string,
    payload: AgentRuntimeConfigPayload | undefined,
    sessionCtx: SessionContext,
  ): Promise<void> {
    if (!gitMirrorManager || !payload?.gitRepos?.length) return;
    for (const repo of payload.gitRepos) {
      const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
      const targetPath = join(workspace, localPath);
      sessionCtx.log(`Git: preparing ${repo.url} → ${localPath}${repo.ref ? ` @ ${repo.ref}` : ""}`);

      // D14: ensureMirror is idempotent — clone once, fast return thereafter.
      const mirror = await gitMirrorManager.ensureMirror(repo.url);
      if (mirror.cloned) {
        sessionCtx.log(`Git: cloned ${repo.url} in ${mirror.elapsedMs}ms`);
      }

      // D10: fresh fetch on every new dialog. Failure aborts session creation.
      await gitMirrorManager.fetchMirror(repo.url);

      // If a prior session left a worktree behind at the same path, reuse it
      // rather than fighting the `git worktree add` lock. The matching session
      // branch is re-derived deterministically from (chatId, url) so cleanup
      // later can still drop it.
      if (existsSync(targetPath) && isHubWorktreeMarker(targetPath)) {
        sessionCtx.log(`Git: reusing existing worktree at ${localPath}`);
        ownedWorktrees.push({
          url: repo.url,
          path: targetPath,
          branchName: deriveSessionBranchName(sessionCtx.chatId, repo.url),
        });
        continue;
      }

      const { headCommit, branchName } = await gitMirrorManager.createWorktree({
        url: repo.url,
        ref: repo.ref,
        targetPath,
        sessionKey: sessionCtx.chatId,
      });
      ownedWorktrees.push({ url: repo.url, path: targetPath, branchName });
      sessionCtx.log(`Git: worktree at ${localPath} @ ${headCommit.slice(0, 7)} on ${branchName}`);
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

  /** Bootstrap workspace and generate CLAUDE.md. */
  function runBootstrap(workspace: string, sessionCtx: SessionContext): void {
    bootstrapWorkspace({
      workspacePath: workspace,
      identity: sessionCtx.agent,
      contextTreePath,
      serverUrl: sessionCtx.sdk.serverUrl,
      chatId: sessionCtx.chatId,
    });
    generateClaudeMd(workspace, sessionCtx.agent, contextTreePath);

    // Install the first-tree skill + FIRST-TREE-SOURCE-INTEGRATION block into
    // the workspace by shelling out to `first-tree tree integrate`. Best-effort:
    // integrate failures do not abort session start.
    if (contextTreePath) {
      installFirstTreeIntegration({
        workspacePath: workspace,
        contextTreePath,
        // Prefer the operator-stable agent name; fall back to chatId for
        // pre-refactor handler configs that don't yet thread `agentName`.
        workspaceId: agentName ?? sessionCtx.chatId,
        treeRepoUrl: contextTreeRepoUrl ?? undefined,
        log: (msg) => sessionCtx.log(msg),
      });
    }
  }

  const handler: AgentHandler = {
    async start(message, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = randomUUID();
      cwd = acquireWorkspace(workspaceRoot, sessionCtx.chatId);

      // Always bootstrap on start
      runBootstrap(cwd, sessionCtx);

      // Materialise gitRepos into `<cwd>/<localPath>` worktrees before the
      // child process starts — failures here abort session creation (D10/D13).
      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      await prepareGitWorktrees(cwd, payload, sessionCtx);

      sessionCtx.log(
        `Starting session (${claudeSessionId}), cwd=${cwd}, permissionMode=${config.permissionMode ?? "bypassPermissions"}`,
      );
      spawnQuery(claudeSessionId, sessionCtx);
      const sdkMsg = await toSDKUserMessage(message, sessionCtx, claudeSessionId);
      inputController?.push(sdkMsg);

      sessionCtx.log(`Session started (${claudeSessionId})`);
      return claudeSessionId;
    },

    async resume(message, sessionId, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = sessionId;
      retryCount = 0;
      cwd = acquireWorkspace(workspaceRoot, sessionCtx.chatId);

      // Bootstrap on resume only if .agent/ is missing
      if (!existsSync(join(cwd, ".agent", "identity.json"))) {
        runBootstrap(cwd, sessionCtx);
      }

      // Re-run git preparation: ensureMirror short-circuits if already cloned;
      // fetch picks up upstream changes since the session was suspended; the
      // worktree is reused if still present (handled inside prepareGitWorktrees).
      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      await prepareGitWorktrees(cwd, payload, sessionCtx);

      sessionCtx.log(`Resuming session (${sessionId}), cwd=${cwd}`);
      spawnQuery(sessionId, sessionCtx, sessionId);
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

      // Silently drop any in-flight AskUserQuestion waiters BEFORE killing
      // the SDK transport. Resolving them here would unblock canUseTool,
      // which would then try to write the PermissionResult through a stdin
      // we're about to close — the SDK throws an uncaught
      // 'ProcessTransport is not ready for writing'. Leaving the awaiter
      // Promise stranded is fine: the SDK process is going away and its
      // stack frames GC with it. If the user eventually answers,
      // SessionManager.dispatch sees no matching waiter and routes the
      // `format=question_answer` message through the normal resume path
      // (the answer becomes regular input on the next turn).
      const sessionCtx = ctx;
      if (sessionCtx) {
        const dropped = clearPendingForAgent(sessionCtx.agent.agentId);
        if (dropped > 0) sessionCtx.log(`Cleared ${dropped} pending AskUserQuestion entries on suspend`);
      }

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
      // Reject every in-flight AskUserQuestion for this agent so the SDK
      // unwinds cleanly instead of dangling on a Promise that will never
      // resolve. The supersede happens server-side via archiveSession /
      // claimClient (commit 2); this is the local-process counterpart.
      if (sessionCtx) {
        const dropped = rejectPendingForAgent(sessionCtx.agent.agentId, "Session shutting down.");
        if (dropped > 0) sessionCtx.log(`Rejected ${dropped} pending AskUserQuestion entries during shutdown`);
      }
      // PRD §7.5: shutdown is session termination (explicit terminate,
      // eviction, or client restart). Release worktrees + workspace dir so
      // the next invocation gets a clean slate. `suspend()` alone preserves
      // state on purpose — idle timeout keeps the option to resume.
      if (sessionCtx) await cleanupGitWorktrees(sessionCtx);
      if (cwd) {
        try {
          rmSync(cwd, { recursive: true, force: true });
        } catch (err) {
          sessionCtx?.log(`Workspace cleanup (${cwd}) failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        cwd = null;
      }
    },
  };

  return handler;
};

/** A Hub-managed worktree has a `.git` FILE (not dir) pointing back at the bare mirror. */
function isHubWorktreeMarker(path: string): boolean {
  const gitMarker = join(path, ".git");
  if (!existsSync(gitMarker)) return false;
  try {
    return statSync(gitMarker).isFile();
  } catch {
    return false;
  }
}

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
function generateClaudeMd(workspacePath: string, identity: AgentIdentity, contextTreePath: string | null): void {
  const sections: string[] = [];
  const contextDir = join(workspacePath, ".agent", "context");

  // --- Identity ---
  const name = identity.displayName ?? identity.agentId;
  if (identity.type === "personal_assistant") {
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
