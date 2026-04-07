import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionMode, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import { bootstrapWorkspace } from "../runtime/bootstrap.js";
import type {
  AgentHandler,
  AgentIdentity,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "../runtime/handler.js";
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
    const rawContent = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    const content = message.senderId ? `[From: ${message.senderId}]\n\n${rawContent}` : rawContent;
    return {
      type: "user",
      message: {
        role: "user",
        content,
      },
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
   * resulting in ~90s cold start vs ~17s standalone. Strip these so the child
   * starts clean; the SDK sets its own CLAUDE_CODE_ENTRYPOINT="sdk-ts".
   */
  function buildEnv(sessionCtx: SessionContext): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = { ...process.env };

    // Parent session markers — not needed by the child
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    delete env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS;
    delete env.npm_lifecycle_script;

    return {
      ...env,
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
              result?: string;
              errors?: string[];
              duration_ms?: number;
              total_cost_usd?: number;
              num_turns?: number;
              session_id?: string;
            };
            if (result.subtype === "success") {
              retryCount = 0;
              // Auto-bridge: forward result text back to the chat
              if (result.result && sessionCtx.chatId) {
                sessionCtx.sdk
                  .sendMessage(sessionCtx.chatId, { format: "text", content: result.result })
                  .then(() => sessionCtx.log("Result forwarded to chat"))
                  .catch((err) =>
                    sessionCtx.log(`Failed to forward result: ${err instanceof Error ? err.message : String(err)}`),
                  );
              }
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

  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;

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
  }

  const handler: AgentHandler = {
    async start(message, sessionCtx) {
      ctx = sessionCtx;
      claudeSessionId = randomUUID();
      cwd = acquireWorkspace(workspaceRoot, sessionCtx.chatId);

      // Always bootstrap on start
      runBootstrap(cwd, sessionCtx);

      sessionCtx.log(
        `Starting session (${claudeSessionId}), cwd=${cwd}, permissionMode=${config.permissionMode ?? "bypassPermissions"}`,
      );
      spawnQuery(claudeSessionId, sessionCtx);
      const sdkMsg = toSDKUserMessage(message, claudeSessionId);
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

/**
 * Generate a CLAUDE.md file from .agent/ bootstrap data.
 *
 * Layer 1 (always): Agent identity + profile (from Hub)
 * Layer 2 (if Context Tree configured): Operating instructions + domain map
 * Layer 3 (if Context Tree configured): Context Tree location for on-demand reading
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

  // --- Agent profile (from Hub) ---
  const selfMdPath = join(contextDir, "self.md");
  if (existsSync(selfMdPath)) {
    const selfContent = readFileSync(selfMdPath, "utf-8");
    sections.push(`## Your Profile\n\n${selfContent}\n`);
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
