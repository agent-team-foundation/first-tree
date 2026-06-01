import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentRuntimeConfigPayload,
  DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD,
  deriveRepoLocalPath,
} from "@first-tree/shared";
import type { AgentConfigCache } from "../../runtime/agent-config-cache.js";
import {
  bootstrapWorkspace,
  buildChatSystemPrompt,
  installFirstTreeIntegration,
  type PredeclaredSourceRepo,
} from "../../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../../runtime/chat-context.js";
import { resolveGitRepoTargetPath } from "../../runtime/git-local-path.js";
import type { GitMirrorManager } from "../../runtime/git-mirror-manager.js";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../../runtime/handler.js";
import { acquireAgentHome, INIT_COMPLETE_SENTINEL_REL, markWorkspaceInitComplete } from "../../runtime/workspace.js";
import { createToolCallProcessor, mapMcpServers } from "../claude-code.js";
import { resolveClaudeCodeExecutable } from "../claude-executable.js";
import { formatQuestionsAsText } from "./ask-user-degrader.js";
import {
  capturePane,
  deriveSessionName,
  killSession,
  listOwnedSessions,
  newSession,
  pasteText,
  sendKey,
  sessionExists,
  waitForReady,
} from "./tmux-session.js";
import { type RawTranscriptEntry, TranscriptTailer, transcriptPathFor } from "./transcript-tail.js";
import { ASKUSER_MENU_FOOTER, ASKUSER_TOOL_NAME, WORKING_MARKER } from "./tui-markers.js";

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_POLL_MS = 250;
const TURN_GRACE_MS = 1500;
const READY_TIMEOUT_MS = 30_000;
const SHORT_PROMPT_INLINE_THRESHOLD = 200;

type Worktree = { url: string; path: string; branchName: string };

/**
 * Module-level lazy sweep: on first handler instantiation in this process,
 * kill all `ftth-*` tmux sessions left over from prior runs. We can be
 * aggressive because Hub Client is the only thing that creates them — anything
 * the registry doesn't know about is orphaned.
 */
let orphanSweepDone = false;
async function orphanSweep(): Promise<void> {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  try {
    const owned = await listOwnedSessions();
    for (const name of owned) {
      try {
        await killSession(name);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Claude Code TUI Handler — drives `claude` (interactive TUI) through tmux.
 *
 * Replaces the SDK-based `claude-code` handler with a tmux-driven equivalent
 * for the post-SDK-sunset world. Input is injected via `paste-buffer`;
 * events stream from `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
 * (claude's per-session transcript). AskUserQuestion is gracefully degraded
 * to a plain-text round-trip via Escape-cancel — the tool stays enabled.
 *
 * See `experiments/tmux-claude-runtime/FINDINGS.md` for the design rationale
 * and PoC verification matrix.
 */
export const createClaudeCodeTuiHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const gitMirrorManager = (config.gitMirrorManager as GitMirrorManager | undefined) ?? null;
  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;
  const contextTreeRepoUrl = (config.contextTreeRepoUrl as string | undefined) ?? null;
  const agentName = (config.agentName as string | undefined) ?? null;
  const claudeCodeExecutable =
    (config.claudeCodeExecutable as string | undefined) ?? resolveClaudeCodeExecutable().path ?? "claude";

  let cwd: string | null = null;
  let tmuxSessionName: string | null = null;
  let transcriptTailer: TranscriptTailer | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let turnAborted = false;
  let ctx: SessionContext | null = null;
  let configTempDir: string | null = null;
  let drainScheduled = false;
  const queuedMessages: SessionMessage[] = [];
  const ownedWorktrees: Worktree[] = [];
  // Per-chat state captured at session start — surfaced into the
  // --append-system-prompt block via buildChatSystemPrompt. Unlike the SDK
  // path the TUI handler can't update the prompt between turns (claude is a
  // persistent process), so we snapshot once per startClaude().
  let chatContextForPrompt: ChatContext | undefined;
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];

  function buildEnv(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    for (const e of payload.env) env[e.key] = e.value;
    const merged = sessionCtx.buildAgentEnv(env);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  /**
   * Compose the `--append-system-prompt` content: agent-config-managed
   * append (from payload.prompt.append) + the per-chat block built via
   * `buildChatSystemPrompt` (working-dir convention, source repos,
   * worktree-on-demand, chat context). Mirrors the claude-code SDK
   * handler's `combinedAppend` — both providers feed claude through the
   * same prompt-append channel; we just deliver it via a CLI flag instead
   * of a Query option.
   */
  function buildPromptAppend(payload: AgentRuntimeConfigPayload, workspaceCwd: string | null): string {
    const agentConfigAppend = payload.prompt.append?.trim() ?? "";
    const perChatAppend = workspaceCwd
      ? buildChatSystemPrompt({
          agentHome: workspaceCwd,
          chatContext: chatContextForPrompt,
          sourceRepos: sourceReposForPrompt,
        }).trim()
      : "";
    return [agentConfigAppend, perChatAppend].filter((s) => s.length > 0).join("\n\n");
  }

  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
    try {
      return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
    } catch (err) {
      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  function ensureFirstTreeBinding(workspace: string, sessionCtx: SessionContext): void {
    if (!contextTreePath) return;
    installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath,
      workspaceId: agentName ?? sessionCtx.chatId,
      treeRepoUrl: contextTreeRepoUrl ?? undefined,
      log: (msg) => sessionCtx.log(msg),
    });
  }

  /**
   * Materialise predeclared source repos at the top level of the agent
   * home and update `sourceReposForPrompt` so they show up in the per-chat
   * system-prompt block. Mirrors claude-code.ts's `refreshSourceRepos` —
   * sessionKey is the agent name (not chatId), so two chats reuse the
   * same checkout instead of forking branches per-chat.
   *
   * Cleanup tracking is omitted: predeclared source repos are agent-scoped
   * persistent resources that survive shutdown.
   */
  async function prepareGitWorktrees(
    payload: AgentRuntimeConfigPayload,
    workspaceCwd: string,
    sessionCtx: SessionContext,
  ): Promise<void> {
    sourceReposForPrompt = [];
    if (!gitMirrorManager) return;
    const branchAgentKey = agentName ?? sessionCtx.agent.agentId;
    for (const repo of payload.gitRepos) {
      const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
      if (!localPath) continue;
      const targetPath = resolveGitRepoTargetPath(workspaceCwd, localPath);
      try {
        await gitMirrorManager.ensureMirror(repo.url);
        await gitMirrorManager.fetchMirror(repo.url);
        let branchName: string;
        if (existsSync(targetPath)) {
          // Reuse path; nothing more to do — buildChatSystemPrompt still
          // wants the metadata so the agent knows where the checkout is.
          branchName = repo.ref ?? "main";
        } else {
          const result = await gitMirrorManager.createWorktree({
            url: repo.url,
            ref: repo.ref,
            targetPath,
            sessionKey: branchAgentKey,
            agentName: branchAgentKey,
          });
          branchName = result.branchName;
          // Source repos are agent-scoped persistent resources (per
          // proposals/agent-session-cwd-redesign §⑤) — they survive
          // shutdown so the next chat finds them ready. Intentionally
          // NOT tracked in ownedWorktrees.
        }
        sourceReposForPrompt.push({
          absolutePath: targetPath,
          url: repo.url,
          ...(repo.ref ? { ref: repo.ref } : {}),
          branch: branchName,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.log(`tui git materialisation skipped (${repo.url}): ${msg}`);
      }
    }
  }

  function ensureConfigTempDir(workspaceCwd: string, sessionId: string): string {
    const dir = join(workspaceCwd, ".claude-code-tui", sessionId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Build claude CLI args. Returns the joined command string ready for tmux
   * (tmux runs through the user's $SHELL, which handles quoting reasonably).
   * Inputs that contain spaces are shell-quoted defensively.
   */
  function buildClaudeCommand(input: {
    sessionId: string;
    resumeSessionId: string | null;
    payload: AgentRuntimeConfigPayload;
    workspaceCwd: string;
    claudeBin: string;
  }): string {
    const { sessionId, resumeSessionId, payload, workspaceCwd, claudeBin } = input;
    const args: string[] = [
      shellQuote(claudeBin),
      "--dangerously-skip-permissions",
      "--session-id",
      shellQuote(sessionId),
    ];
    if (resumeSessionId) {
      args.push("--resume", shellQuote(resumeSessionId));
    }
    if (payload.model) {
      args.push("--model", shellQuote(payload.model));
    }

    const tempDir = ensureConfigTempDir(workspaceCwd, sessionId);
    configTempDir = tempDir;

    const promptAppend = buildPromptAppend(payload, workspaceCwd).trim();
    if (promptAppend.length > 0) {
      if (promptAppend.length <= SHORT_PROMPT_INLINE_THRESHOLD && !promptAppend.includes("\n")) {
        args.push("--append-system-prompt", shellQuote(promptAppend));
      } else {
        const path = join(tempDir, "system-prompt-append.txt");
        writeFileSync(path, promptAppend, "utf-8");
        args.push("--append-system-prompt-file", shellQuote(path));
      }
    }

    if (payload.mcpServers.length > 0) {
      const mcpConfigPath = join(tempDir, "mcp-config.json");
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mapMcpServers(payload) }, null, 2), "utf-8");
      args.push("--mcp-config", shellQuote(mcpConfigPath));
      args.push("--strict-mcp-config");
    }

    args.push("--setting-sources", "user,project");

    return args.join(" ");
  }

  async function loadPayload(sessionCtx: SessionContext): Promise<AgentRuntimeConfigPayload | null> {
    if (!agentConfigCache) return null;
    const cached = agentConfigCache.get(sessionCtx.agent.agentId);
    if (cached) return cached.payload;
    const refreshed = await agentConfigCache.refresh(sessionCtx.agent.agentId);
    return refreshed.payload;
  }

  async function startClaude(input: { sessionCtx: SessionContext; resumeSessionId: string | null }): Promise<string> {
    const { sessionCtx, resumeSessionId } = input;
    if (!cwd) throw new Error("startClaude called before cwd was acquired");

    const payload = (await loadPayload(sessionCtx)) ?? defaultPayload();

    const sessionId = resumeSessionId ?? randomUUID();
    const sessionName = deriveSessionName(sessionCtx.agent.agentId, sessionCtx.chatId);
    if (await sessionExists(sessionName)) {
      await killSession(sessionName);
    }

    const command = buildClaudeCommand({
      sessionId,
      resumeSessionId,
      payload,
      workspaceCwd: cwd,
      claudeBin: claudeCodeExecutable,
    });

    await newSession({
      name: sessionName,
      cwd,
      command,
      env: buildEnv(sessionCtx, payload),
    });
    await waitForReady({ name: sessionName, timeoutMs: READY_TIMEOUT_MS });

    tmuxSessionName = sessionName;
    transcriptTailer = new TranscriptTailer(transcriptPathFor(cwd, sessionId));
    return sessionId;
  }

  function defaultPayload(): AgentRuntimeConfigPayload {
    // Reuse the shared default so this stays in sync with the schema (e.g. the
    // `reasoningEffort` field) instead of hand-maintaining the literal here.
    return { ...DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD };
  }

  /**
   * Process raw transcript entries: feed them to the shared tool-call
   * processor (which emits assistant_text / thinking / tool_call events),
   * and pull out two side channels we need locally:
   *   - assistant text → accumulated for `forwardResult`
   *   - AskUserQuestion tool_use → degraded to plain text
   */
  type TurnState = {
    finalTexts: string[];
    askUserTexts: string[];
    seenToolUseIds: Set<string>;
  };

  function consumeEntry(entry: RawTranscriptEntry, sessionCtx: SessionContext, state: TurnState): void {
    // Feed the shared processor — it emits all the session events we'd
    // otherwise have to reimplement (assistant_text / thinking / tool_call
    // pending / tool_call final, plus context_tree_usage when bound).
    processor(sessionCtx).onMessage(entry);

    if (entry?.type !== "assistant") return;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    for (const blk of content as Array<Record<string, unknown>>) {
      if (blk.type === "text" && typeof blk.text === "string") {
        const text = blk.text.trim();
        if (text.length > 0) state.finalTexts.push(blk.text);
      } else if (blk.type === "tool_use" && typeof blk.id === "string" && blk.name === ASKUSER_TOOL_NAME) {
        if (state.seenToolUseIds.has(blk.id)) continue;
        state.seenToolUseIds.add(blk.id);
        state.askUserTexts.push(formatQuestionsAsText(blk.input));
      }
    }
  }

  // Single processor instance per turn (constructed lazily because we need
  // the session ctx). Reset between turns to free its `pending` map.
  let turnProcessor: ReturnType<typeof createToolCallProcessor> | null = null;
  function processor(sessionCtx: SessionContext): ReturnType<typeof createToolCallProcessor> {
    if (!turnProcessor) {
      turnProcessor = createToolCallProcessor(
        (event) => sessionCtx.emitEvent(event),
        contextTreePath ? { path: contextTreePath, repoUrl: contextTreeRepoUrl } : undefined,
      );
    }
    return turnProcessor;
  }
  function resetProcessor(): void {
    turnProcessor?.flush();
    turnProcessor = null;
  }

  async function drainAndConsume(sessionCtx: SessionContext, state: TurnState): Promise<void> {
    if (!transcriptTailer) return;
    for (const entry of transcriptTailer.drainEntries()) {
      consumeEntry(entry, sessionCtx, state);
    }
  }

  async function runTurn(text: string, sessionCtx: SessionContext): Promise<void> {
    if (!tmuxSessionName || !transcriptTailer) {
      throw new Error("runTurn called before session was prepared");
    }
    sessionCtx.setRuntimeState("working");
    turnAborted = false;

    const state: TurnState = { finalTexts: [], askUserTexts: [], seenToolUseIds: new Set() };
    let turnFailed = false;
    let everSawWorking = false;

    try {
      // Pre-flush whatever's already in the transcript (the prior turn's
      // tail end) so it doesn't pollute this turn's text accumulation.
      transcriptTailer.drainEntries();

      await pasteText(tmuxSessionName, text);
      sessionCtx.touch();

      const startTs = Date.now();
      while (Date.now() - startTs < TURN_TIMEOUT_MS) {
        if (turnAborted) break;
        sessionCtx.touch();

        await drainAndConsume(sessionCtx, state);

        const pane = await capturePane(tmuxSessionName);
        const working = pane.includes(WORKING_MARKER);
        if (working) everSawWorking = true;

        if (pane.includes(ASKUSER_MENU_FOOTER)) {
          // Cancel the TUI selection menu — claude will flush the cancelled
          // tool_use to the transcript on the next tick.
          try {
            await sendKey(tmuxSessionName, "Escape");
          } catch (err) {
            sessionCtx.log(`tui Escape failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (everSawWorking && !working) {
          // Final flush grace period — claude writes the closing
          // assistant_text block to the transcript after the working
          // marker disappears.
          const graceUntil = Date.now() + TURN_GRACE_MS;
          while (Date.now() < graceUntil) {
            await drainAndConsume(sessionCtx, state);
            await sleep(150);
          }
          break;
        }

        await sleep(TURN_POLL_MS);
      }

      // One last pass in case the timeout-or-break left entries behind.
      await drainAndConsume(sessionCtx, state);
    } catch (err) {
      turnFailed = true;
      sessionCtx.emitEvent({
        kind: "error",
        payload: { source: "runtime", message: err instanceof Error ? err.message : String(err) },
      });
    }

    // Compose the final user-facing text. AskUserQuestion text takes priority
    // — when claude tried to ask a structured question, that question (not
    // any preceding assistant text) is the meaningful payload for the user.
    let finalText = "";
    if (state.askUserTexts.length > 0) {
      finalText = state.askUserTexts.join("\n\n");
    } else {
      finalText = state.finalTexts.join("\n\n").trim();
    }

    let forwardFailed = false;
    if (finalText.trim()) {
      try {
        await sessionCtx.forwardResult(finalText);
      } catch (err) {
        forwardFailed = true;
        sessionCtx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: `forwardResult failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        });
      }
    }

    sessionCtx.emitEvent({
      kind: "turn_end",
      payload: { status: !turnFailed && !forwardFailed ? "success" : "error" },
    });
    sessionCtx.setRuntimeState("idle");
    resetProcessor();

    if (queuedMessages.length > 0 && !drainScheduled) {
      drainScheduled = true;
      setImmediate(() => {
        drainScheduled = false;
        const drained = queuedMessages.splice(0);
        if (drained.length === 0 || !ctx) return;
        void mergeAndRun(drained, ctx);
      });
    }
  }

  async function mergeAndRun(drained: SessionMessage[], sessionCtx: SessionContext): Promise<void> {
    const inputs: string[] = [];
    for (const m of drained) {
      try {
        inputs.push(await sessionCtx.formatInboundContent(m));
      } catch (err) {
        sessionCtx.log(`tui inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (inputs.length === 0) return;
    const promise = runTurn(inputs.join("\n\n"), sessionCtx);
    currentTurnPromise = promise;
    try {
      await promise;
    } finally {
      currentTurnPromise = null;
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  function shellQuote(value: string): string {
    if (!value) return "''";
    if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  async function teardownTmux(): Promise<void> {
    if (tmuxSessionName) {
      try {
        await killSession(tmuxSessionName);
      } catch {
        /* best-effort */
      }
    }
    tmuxSessionName = null;
    transcriptTailer = null;
    if (configTempDir && existsSync(configTempDir)) {
      try {
        rmSync(configTempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    configTempDir = null;
  }

  return {
    async start(message, sessionCtx) {
      await orphanSweep();
      ctx = sessionCtx;
      cwd = acquireAgentHome(workspaceRoot);

      const payload = (await loadPayload(sessionCtx)) ?? defaultPayload();

      // Per-chat material flows through the system-prompt-append channel
      // built in `buildPromptAppend` — bootstrapWorkspace itself only writes
      // agent-stable files now (per-agent-home redesign, proposals/2026-05-19).
      chatContextForPrompt = await fetchChatContextOrLog(sessionCtx);
      bootstrapWorkspace({
        workspacePath: cwd,
        identity: sessionCtx.agent,
        contextTreePath,
        serverUrl: sessionCtx.sdk.serverUrl,
      });
      ensureFirstTreeBinding(cwd, sessionCtx);
      await prepareGitWorktrees(payload, cwd, sessionCtx);
      markWorkspaceInitComplete(cwd);

      const sessionId = await startClaude({ sessionCtx, resumeSessionId: null });

      const inputText = await sessionCtx.formatInboundContent(message);
      const promise = runTurn(inputText, sessionCtx);
      currentTurnPromise = promise;
      try {
        await promise;
      } finally {
        currentTurnPromise = null;
      }
      return sessionId;
    },

    async resume(message, sessionId, sessionCtx) {
      await orphanSweep();
      ctx = sessionCtx;
      cwd = acquireAgentHome(workspaceRoot);

      const payload = (await loadPayload(sessionCtx)) ?? defaultPayload();

      chatContextForPrompt = await fetchChatContextOrLog(sessionCtx);
      bootstrapWorkspace({
        workspacePath: cwd,
        identity: sessionCtx.agent,
        contextTreePath,
        serverUrl: sessionCtx.sdk.serverUrl,
      });
      if (!existsSync(join(cwd, INIT_COMPLETE_SENTINEL_REL))) {
        ensureFirstTreeBinding(cwd, sessionCtx);
      }
      await prepareGitWorktrees(payload, cwd, sessionCtx);
      markWorkspaceInitComplete(cwd);

      const restartedId = await startClaude({ sessionCtx, resumeSessionId: sessionId });

      if (message) {
        const inputText = await sessionCtx.formatInboundContent(message);
        const promise = runTurn(inputText, sessionCtx);
        currentTurnPromise = promise;
        try {
          await promise;
        } finally {
          currentTurnPromise = null;
        }
      }
      return restartedId;
    },

    inject(message) {
      if (currentTurnPromise) {
        queuedMessages.push(message);
        return;
      }
      const sessionCtx = ctx;
      if (!sessionCtx || !tmuxSessionName) return;
      void (async () => {
        try {
          const text = await sessionCtx.formatInboundContent(message);
          const promise = runTurn(text, sessionCtx);
          currentTurnPromise = promise;
          try {
            await promise;
          } finally {
            currentTurnPromise = null;
          }
        } catch (err) {
          sessionCtx.log(`tui inject failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },

    async suspend() {
      turnAborted = true;
      if (tmuxSessionName) {
        try {
          await sendKey(tmuxSessionName, "Escape");
        } catch {
          /* best-effort */
        }
      }
      try {
        await currentTurnPromise;
      } catch {
        /* swallow */
      }
      currentTurnPromise = null;
      await teardownTmux();
    },

    async shutdown() {
      turnAborted = true;
      if (tmuxSessionName) {
        try {
          await sendKey(tmuxSessionName, "Escape");
        } catch {
          /* best-effort */
        }
      }
      try {
        await currentTurnPromise;
      } catch {
        /* swallow */
      }
      currentTurnPromise = null;
      await teardownTmux();

      // Per agent-session-cwd-redesign: cwd is the per-agent home — shared
      // by every chat. shutdown() must NOT remove it; that would wipe
      // persistent state and source-repo checkouts other chats may resume
      // against. Source repos are also intentionally left in place
      // (proposals/agent-session-cwd-redesign §⑤). On-demand worktrees the
      // agent created under `<cwd>/worktrees/<name>/` belong to the agent.
      if (gitMirrorManager) {
        for (const wt of ownedWorktrees) {
          try {
            await gitMirrorManager.removeWorktree({ url: wt.url, path: wt.path, branchName: wt.branchName });
          } catch (err) {
            ctx?.log(`tui worktree cleanup failed (${wt.path}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        ownedWorktrees.length = 0;
      }
      cwd = null;
      ctx = null;
      queuedMessages.length = 0;
    },
  } satisfies AgentHandler;
};
