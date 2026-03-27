import { randomUUID } from "node:crypto";
import type { PermissionMode, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { InputController } from "../runtime/input-controller.js";
import { acquireWorkspace } from "../runtime/workspace.js";

const MAX_RETRIES = 2;

/**
 * Claude Code Handler — session-oriented handler using the Agent SDK.
 *
 * Each handler instance owns a single Claude session for one chat.
 * Uses streaming input (InputController) for mid-processing message injection
 * and session resume from disk for idle reclaim recovery.
 */
export const createClaudeCodeHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;

  let cwd: string | null = null;
  let claudeSessionId: string | null = null;
  let currentQuery: Query | null = null;
  let inputController: InputController<SDKUserMessage> | null = null;
  let abortController: AbortController | null = null;
  let consumerDone: Promise<void> | null = null;
  let retryCount = 0;
  let ctx: SessionContext | null = null;

  function toSDKUserMessage(message: SessionMessage, sessionId: string): SDKUserMessage {
    return {
      type: "user",
      message: {
        role: "user",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    };
  }

  function buildEnv(sessionCtx: SessionContext): Record<string, string | undefined> {
    return {
      ...process.env,
      FIRST_TREE_HUB_SERVER_URL: sessionCtx.sdk.serverUrl,
      FIRST_TREE_HUB_AGENT_TOKEN: sessionCtx.sdk.agentToken,
      FIRST_TREE_HUB_CHAT_ID: sessionCtx.chatId,
      FIRST_TREE_HUB_AGENT_ID: sessionCtx.agent.agentId,
    };
  }

  /** Create query and input controller, then start consumer loop. */
  function spawnQuery(sessionId: string, sessionCtx: SessionContext, resume?: string): void {
    buildQuery(sessionId, sessionCtx, resume);
    consumerDone = consumeOutput(sessionCtx);
  }

  /** Rebuild query and input controller without starting a new consumer loop (used for retry within the existing loop). */
  function respawnQuery(sessionId: string, sessionCtx: SessionContext): void {
    buildQuery(sessionId, sessionCtx, sessionId);
  }

  function buildQuery(sessionId: string, sessionCtx: SessionContext, resume?: string): void {
    inputController = new InputController<SDKUserMessage>();
    abortController = new AbortController();

    const permissionMode = (config.permissionMode as PermissionMode | undefined) ?? "bypassPermissions";

    currentQuery = claudeQuery({
      prompt: inputController.iterable,
      options: {
        sessionId: resume ? undefined : sessionId,
        resume,
        cwd: cwd ?? undefined,
        persistSession: true,
        abortController,
        permissionMode,
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        env: buildEnv(sessionCtx),
      },
    });
  }

  async function consumeOutput(sessionCtx: SessionContext): Promise<void> {
    while (true) {
      if (!currentQuery) return;

      try {
        for await (const message of currentQuery) {
          // Every message refreshes lastActivity to prevent idle timeout
          sessionCtx.touch();

          if (message.type === "result") {
            const result = message as {
              type: "result";
              subtype: string;
              errors?: string[];
              duration_ms?: number;
              total_cost_usd?: number;
              num_turns?: number;
              session_id?: string;
            };
            if (result.subtype === "success") {
              retryCount = 0;
            } else {
              const errors = result.errors ? result.errors.join("; ") : result.subtype;
              sessionCtx.log(
                `Query result error: ${errors} (subtype=${result.subtype}, turns=${result.num_turns ?? "?"}, duration=${result.duration_ms ?? "?"}ms)`,
              );
            }
          }
        }
        // Normal completion — exit loop
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
          return;
        }

        // Automatic retry — respawn query and continue loop
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
  }

  const handler: AgentHandler = {
    async start(message, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = randomUUID();
      cwd = acquireWorkspace(workspaceRoot, sessionCtx.chatId);

      sessionCtx.log(
        `Starting session (${claudeSessionId}), cwd=${cwd}, permissionMode=${config.permissionMode ?? "bypassPermissions"}`,
      );
      spawnQuery(claudeSessionId, sessionCtx);
      inputController?.push(toSDKUserMessage(message, claudeSessionId));

      sessionCtx.log(`Session started (${claudeSessionId})`);
      return claudeSessionId;
    },

    async resume(message, sessionId, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = sessionId;
      retryCount = 0;
      cwd = acquireWorkspace(workspaceRoot, sessionCtx.chatId);

      sessionCtx.log(`Resuming session (${sessionId}), cwd=${cwd}`);
      spawnQuery(sessionId, sessionCtx, sessionId);
      inputController?.push(toSDKUserMessage(message, sessionId));

      sessionCtx.log(`Session resumed (${sessionId})`);
      return sessionId;
    },

    inject(message) {
      if (!inputController || !claudeSessionId) {
        ctx?.log("inject() called but no active session — dropping message");
        return;
      }
      inputController.push(toSDKUserMessage(message, claudeSessionId));
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
      await handler.suspend();
    },
  };

  return handler;
};
