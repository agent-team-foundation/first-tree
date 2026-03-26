import { randomUUID } from "node:crypto";
import type { Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { InputController } from "../runtime/input-controller.js";

const MAX_RETRIES = 2;

/**
 * Claude Code Handler — session-oriented handler using the Agent SDK.
 *
 * Each handler instance owns a single Claude session for one chat.
 * Uses streaming input (InputController) for mid-processing message injection
 * and session resume from disk for idle reclaim recovery.
 */
export const createClaudeCodeHandler: HandlerFactory = (config) => {
  const cwd = config.cwd;

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
      // Access private fields via cast — SDK does not expose these publicly
      AGENT_HUB_SERVER_URL: (sessionCtx.sdk as unknown as { baseUrl: string }).baseUrl,
      AGENT_HUB_AGENT_TOKEN: (sessionCtx.sdk as unknown as { token: string }).token,
      AGENT_HUB_CHAT_ID: sessionCtx.chatId,
      AGENT_HUB_AGENT_ID: sessionCtx.agent.agentId,
    };
  }

  function spawnQuery(sessionId: string, sessionCtx: SessionContext, resume?: string): void {
    inputController = new InputController<SDKUserMessage>();
    abortController = new AbortController();

    currentQuery = claudeQuery({
      prompt: inputController.iterable,
      options: {
        sessionId: resume ? undefined : sessionId,
        resume,
        cwd,
        persistSession: true,
        abortController,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        env: buildEnv(sessionCtx),
      },
    });

    consumerDone = consumeOutput(sessionCtx);
  }

  async function consumeOutput(sessionCtx: SessionContext): Promise<void> {
    if (!currentQuery) return;

    try {
      for await (const message of currentQuery) {
        // Every message refreshes lastActivity to prevent idle timeout
        sessionCtx.touch();

        if (message.type === "result") {
          const result = message as { type: "result"; subtype: string; errors?: string[] };
          if (result.subtype === "success") {
            // Session processing complete — reset retry count
            retryCount = 0;
          } else {
            // Error result — log it
            const errors = result.errors ? result.errors.join("; ") : result.subtype;
            sessionCtx.log(`Query result error: ${errors}`);
          }
        }
        // All other message types are silently consumed for lifecycle tracking
      }
    } catch (err) {
      // Process crash, OOM, or unexpected termination
      const errMsg = err instanceof Error ? err.message : String(err);
      sessionCtx.log(`Query error: ${errMsg}`);

      // Layer 1: Automatic resume (silent recovery)
      if (retryCount < MAX_RETRIES && claudeSessionId) {
        retryCount++;
        sessionCtx.log(`Attempting auto-resume (retry ${retryCount}/${MAX_RETRIES})`);
        try {
          spawnQuery(claudeSessionId, sessionCtx, claudeSessionId);
          return;
        } catch (resumeErr) {
          sessionCtx.log(`Auto-resume failed: ${resumeErr instanceof Error ? resumeErr.message : String(resumeErr)}`);
        }
      }

      // Layer 2: Log and suspend (graceful degradation)
      sessionCtx.log("Exhausted retries, session will be suspended");
    }
  }

  const handler: AgentHandler = {
    async start(message, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = randomUUID();

      spawnQuery(claudeSessionId, sessionCtx);
      inputController?.push(toSDKUserMessage(message, claudeSessionId));

      sessionCtx.log(`Session started (${claudeSessionId})`);
      return claudeSessionId;
    },

    async resume(message, sessionId, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = sessionId;
      retryCount = 0;

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
