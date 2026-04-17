import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeConfigPayload } from "@agent-team-foundation/first-tree-hub-shared";
import { deriveRepoLocalPath } from "@agent-team-foundation/first-tree-hub-shared";
import type { McpServerConfig, PermissionMode, Query, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { query as claudeQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import { bootstrapWorkspace } from "../runtime/bootstrap.js";
import type { GitMirrorManager } from "../runtime/git-mirror-manager.js";
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
  /** Worktree paths materialised for this session — removed on shutdown. */
  const ownedWorktrees: string[] = [];

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
    return {
      ...env,
      FIRST_TREE_HUB_SERVER_URL: sessionCtx.sdk.serverUrl,
      FIRST_TREE_HUB_AGENT_ID: sessionCtx.agent.agentId,
      FIRST_TREE_HUB_CHAT_ID: sessionCtx.chatId,
    };
  }

  /** Create query and input controller, then start consumer loop. */
  function spawnQuery(sessionId: string, sessionCtx: SessionContext, resume?: string): void {
    buildQuery(sessionId, sessionCtx, resume);
    recordAppliedPayload(sessionCtx);
    consumerDone = consumeOutput(sessionCtx);
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
        env: buildEnv(sessionCtx),
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
    while (true) {
      if (!currentQuery) return;

      try {
        sessionCtx.setRuntimeState("working");

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
                sessionCtx.appendOutput(result.result);

                sessionCtx.sdk
                  .sendMessage(sessionCtx.chatId, { format: "text", content: result.result })
                  .then(() => sessionCtx.log("Result forwarded to chat"))
                  .catch((err) =>
                    sessionCtx.log(`Failed to forward result: ${err instanceof Error ? err.message : String(err)}`),
                  );
              }
            } else {
              const errors = result.errors ? result.errors.join("; ") : result.subtype;
              const errorLog = `Query result error: ${errors} (subtype=${result.subtype}, turns=${result.num_turns ?? "?"}, duration=${result.duration_ms ?? "?"}ms)`;
              sessionCtx.log(errorLog);
              sessionCtx.appendOutput(`[ERROR] ${errorLog}`);
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
      // rather than fighting the `git worktree add` lock.
      if (existsSync(targetPath) && isHubWorktreeMarker(targetPath)) {
        sessionCtx.log(`Git: reusing existing worktree at ${localPath}`);
        ownedWorktrees.push(targetPath);
        continue;
      }

      const { headCommit } = await gitMirrorManager.createWorktree({
        url: repo.url,
        ref: repo.ref,
        targetPath,
      });
      ownedWorktrees.push(targetPath);
      sessionCtx.log(`Git: worktree at ${localPath} @ ${headCommit.slice(0, 7)}`);
    }
  }

  /** Tear down all worktrees this session owns; best-effort. */
  async function cleanupGitWorktrees(sessionCtx: SessionContext): Promise<void> {
    if (!gitMirrorManager) return;
    while (ownedWorktrees.length > 0) {
      const path = ownedWorktrees.pop();
      if (!path) continue;
      try {
        await gitMirrorManager.removeWorktree(path);
      } catch (err) {
        sessionCtx.log(`Git: removeWorktree(${path}) failed — ${err instanceof Error ? err.message : String(err)}`);
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

      // Re-run git preparation: ensureMirror short-circuits if already cloned;
      // fetch picks up upstream changes since the session was suspended; the
      // worktree is reused if still present (handled inside prepareGitWorktrees).
      const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
      await prepareGitWorktrees(cwd, payload, sessionCtx);

      sessionCtx.log(`Resuming session (${sessionId}), cwd=${cwd}`);
      spawnQuery(sessionId, sessionCtx, sessionId);
      if (message) {
        inputController?.push(toSDKUserMessage(message, sessionId));
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
        .finally(() => {
          inputController?.push(toSDKUserMessage(message, sid));
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
