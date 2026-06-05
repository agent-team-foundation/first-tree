import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRuntimeConfigPayload, DEFAULT_CLAUDE_CODE_TUI_RUNTIME_CONFIG_PAYLOAD } from "@first-tree/shared";
import { ensureAgentBootstrap } from "../../runtime/agent-bootstrap.js";
import { buildAgentBriefing } from "../../runtime/agent-briefing.js";
import type { AgentConfigCache } from "../../runtime/agent-config-cache.js";
import type { PredeclaredSourceRepo } from "../../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../../runtime/chat-context.js";
import type { GitMirrorManager } from "../../runtime/git-mirror-manager.js";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../../runtime/handler.js";
import { prepareSourceRepos } from "../../runtime/source-repos.js";
import { acquireAgentHome, markWorkspaceInitComplete } from "../../runtime/workspace.js";
import { createToolCallProcessor, mapMcpServers } from "../claude-code.js";
import { resolveClaudeCodeExecutable } from "../claude-executable.js";
import {
  capturePane,
  deriveSessionName,
  killSession,
  listOwnedSessions,
  newSession,
  ownedSessionPrefix,
  pasteText,
  sendKey,
  sessionExists,
  waitForReady,
} from "./tmux-session.js";
import { type RawTranscriptEntry, TranscriptTailer, transcriptPathFor } from "./transcript-tail.js";
import { WORKING_MARKER } from "./tui-markers.js";
import { resolveTurnDisposition } from "./turn-disposition.js";

const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const TURN_POLL_MS = 250;
const TURN_GRACE_MS = 1500;
const READY_TIMEOUT_MS = 30_000;

type Worktree = { url: string; path: string; branchName: string };

/**
 * Module-level lazy sweep: on first handler instantiation in this process, kill
 * tmux sessions left over from a prior crashed run of THIS client.
 *
 * Scoped by the client-owner prefix (`ftth-<clientTag>-`), never the bare
 * `ftth-` prefix: multiple client processes (prod / staging / dev) and parallel
 * QA slots share one tmux server, so a blanket sweep would kill sessions a
 * concurrent live process is actively driving. The client tag is stable across
 * restarts of the same client, so we still reclaim our own orphans.
 */
let orphanSweepDone = false;
async function orphanSweep(clientId: string): Promise<void> {
  if (orphanSweepDone) return;
  orphanSweepDone = true;
  try {
    const owned = await listOwnedSessions(ownedSessionPrefix(clientId));
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
 * (claude's per-session transcript).
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
  const contextTreeBranch = (config.contextTreeBranch as string | undefined) ?? null;
  const agentName = (config.agentName as string | undefined) ?? null;
  // Identifies this client process; scopes tmux session ownership so the orphan
  // sweep and session names never collide with another live client / QA slot
  // on the shared tmux server. Empty string is tolerated (falls back to a
  // placeholder tag) but the daemon always supplies a real client id.
  const clientId = (config.clientId as string | undefined) ?? "";
  const claudeCodeExecutable =
    (config.claudeCodeExecutable as string | undefined) ?? resolveClaudeCodeExecutable().path ?? "claude";

  let cwd: string | null = null;
  let tmuxSessionName: string | null = null;
  let transcriptTailer: TranscriptTailer | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let turnAborted = false;
  // True for the whole span a turn is being prepared/run — start/resume
  // bootstrap through turn completion, or a queued-message turn. This is the
  // single synchronous gate that serialises turn execution: `pump()` starts a
  // queued turn only when this is false, so concurrent injects can never run
  // two turns against one tmux pane.
  let turnRunning = false;
  let ctx: SessionContext | null = null;
  let configTempDir: string | null = null;
  const queuedMessages: SessionMessage[] = [];
  const ownedWorktrees: Worktree[] = [];
  // Per-chat state captured at session start — feeds the unified briefing
  // (AGENTS.md / CLAUDE.md symlink) that claude reads at startup via
  // `--setting-sources user,project`. The TUI handler can't update the
  // briefing mid-thread (claude is a persistent process holding the file
  // contents in memory), so we snapshot once per startClaude().
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
   * Build the unified briefing for the current session — agent identity,
   * payload.prompt.append, source-repo list, chat context, and the Context
   * Tree / runtime sections. Materialised by {@link ensureAgentBootstrap} as
   * `<cwd>/AGENTS.md` (with `<cwd>/CLAUDE.md` symlinked to it) before claude
   * spawns; the CLI then loads CLAUDE.md via `--setting-sources user,project`.
   */
  function buildBriefing(sessionCtx: SessionContext, payload: AgentRuntimeConfigPayload, workspaceCwd: string): string {
    return buildAgentBriefing({
      identity: sessionCtx.agent,
      payload,
      chatContext: chatContextForPrompt,
      workspacePath: workspaceCwd,
      sourceRepos: sourceReposForPrompt,
      contextTreePath,
    });
  }

  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
    try {
      return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
    } catch (err) {
      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
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
      // AskUserQuestion is not supported in First Tree. `--dangerously-skip-permissions`
      // bypasses the permission layer, so disabling it via permissions is impossible here;
      // `--disallowed-tools` removes the tool from the model's context entirely instead.
      "--disallowed-tools",
      "AskUserQuestion",
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

    if (payload.mcpServers.length > 0) {
      const mcpConfigPath = join(tempDir, "mcp-config.json");
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: mapMcpServers(payload) }, null, 2), "utf-8");
      args.push("--mcp-config", shellQuote(mcpConfigPath));
      args.push("--strict-mcp-config");
    }

    // The unified briefing is delivered via `<cwd>/CLAUDE.md` (symlink to
    // AGENTS.md) which `--setting-sources user,project` instructs claude to
    // load at startup. No `--append-system-prompt` is needed anymore.
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
    const sessionName = deriveSessionName(clientId, sessionCtx.agent.agentId, sessionCtx.chatId);
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
    // Track the session name immediately so a waitForReady failure still has a
    // teardown path — otherwise the detached tmux session (and its claude
    // process) leaks until the next process restart's orphan sweep.
    tmuxSessionName = sessionName;
    try {
      await waitForReady({ name: sessionName, timeoutMs: READY_TIMEOUT_MS });
    } catch (err) {
      await killSession(sessionName).catch(() => {});
      tmuxSessionName = null;
      throw err;
    }

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
   * and pull out the assistant text → accumulated for `forwardResult`.
   */
  type TurnState = {
    finalTexts: string[];
  };

  function consumeEntry(entry: RawTranscriptEntry, sessionCtx: SessionContext, state: TurnState): void {
    // Feed the shared processor — it emits all the session events we'd
    // otherwise have to reimplement (assistant_text / thinking / tool_call
    // pending / tool_call final, including tool file refs when available).
    processor(sessionCtx).onMessage(entry);

    if (entry?.type !== "assistant") return;
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    for (const blk of content as Array<Record<string, unknown>>) {
      if (blk.type === "text" && typeof blk.text === "string") {
        const text = blk.text.trim();
        if (text.length > 0) state.finalTexts.push(blk.text);
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
        contextTreePath ? { path: contextTreePath, repoUrl: contextTreeRepoUrl, branch: contextTreeBranch } : undefined,
        { cwd },
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

  async function runTurn(text: string, sessionCtx: SessionContext, ackCount = 1): Promise<void> {
    if (!tmuxSessionName || !transcriptTailer) {
      throw new Error("runTurn called before session was prepared");
    }
    sessionCtx.setRuntimeState("working");
    turnAborted = false;

    const state: TurnState = { finalTexts: [] };
    let turnFailed = false;
    let timedOut = false;
    let everSawWorking = false;
    let brokeOnIdle = false;

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
        // A turn that finishes between two polls may never paint the working
        // marker; treat any produced output as evidence the turn ran so a fast
        // reply doesn't block until TURN_TIMEOUT.
        const producedOutput = state.finalTexts.length > 0;
        const sawActivity = everSawWorking || producedOutput;

        if (sawActivity && !working) {
          // Final flush grace period — claude writes the closing
          // assistant_text block to the transcript after the working
          // marker disappears.
          const graceUntil = Date.now() + TURN_GRACE_MS;
          while (Date.now() < graceUntil) {
            await drainAndConsume(sessionCtx, state);
            await sleep(150);
          }
          brokeOnIdle = true;
          break;
        }

        await sleep(TURN_POLL_MS);
      }

      // One last pass in case the timeout-or-break left entries behind.
      await drainAndConsume(sessionCtx, state);

      // Loop hit the TURN_TIMEOUT ceiling (not a clean idle break, not an
      // explicit abort): claude may still be working. Interrupt it so its
      // output doesn't bleed into the next turn's pane/transcript, and flag the
      // turn as timed out — it is NOT a success. A timed-out turn reports
      // `turn_end: error`, stays un-acked (so the inbox entries are redelivered
      // for a real retry instead of being silently consumed), and settles the
      // runtime into `error` (see resolveTurnDisposition).
      if (!brokeOnIdle && !turnAborted) {
        timedOut = true;
        sessionCtx.log(`tui turn exceeded ${TURN_TIMEOUT_MS}ms without completing; interrupting claude`);
        try {
          await sendKey(tmuxSessionName, "Escape");
        } catch {
          /* best-effort */
        }
        sessionCtx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: `Turn timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s; claude was interrupted before finishing`,
          },
        });
      }
    } catch (err) {
      turnFailed = true;
      sessionCtx.emitEvent({
        kind: "error",
        payload: { source: "runtime", message: err instanceof Error ? err.message : String(err) },
      });
    }

    // Compose the final user-facing text from the accumulated assistant text.
    const finalText = state.finalTexts.join("\n\n").trim();

    // Decide delivery + ack/state from how the turn ended. The `forward` /
    // `ack` flags are independent of forwardResult's own success, so compute
    // them first and use `forward` to gate delivery: on a timeout or a
    // suspend-abort the inbox entry stays un-acked and the message re-runs on
    // reconnect/resume, so forwarding partial output here would double-post
    // (and risk inconsistent output) once the replay produces the real answer.
    let forwardFailed = false;
    const willForward = resolveTurnDisposition({ aborted: turnAborted, timedOut, turnFailed, forwardFailed: false });
    if (willForward.forward && finalText.trim()) {
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

    // Re-resolve with the real forwardFailed folded in (it only affects
    // `status`). The runtime never auto-acks on turn_end (see SessionContext in
    // handler.ts): when `ack` is false the triggering inbox entries stay
    // in-flight and the server redelivers them on reconnect / restart. A clean
    // close acks even on a forward-only failure (mirrors the SDK handler's
    // ackTurnClose, avoiding redelivery storms); an abort or a timeout
    // withholds the ack so the message gets a real retry.
    const disposition = resolveTurnDisposition({ aborted: turnAborted, timedOut, turnFailed, forwardFailed });
    sessionCtx.emitEvent({ kind: "turn_end", payload: { status: disposition.status } });
    if (disposition.ack) {
      sessionCtx.markCompleted(ackCount);
    }
    sessionCtx.setRuntimeState(disposition.runtimeState);
    resetProcessor();
  }

  /**
   * Start a turn for any queued messages, if the session is live and no turn is
   * already running. The single serialisation point for turn execution:
   * `inject()` only ever enqueues + calls `pump()`, and `turnRunning` (a plain
   * synchronous boolean) guarantees at most one turn runs against the tmux pane
   * at a time. `currentTurnPromise` is assigned synchronously before any await
   * so a concurrent `suspend()` awaits the turn instead of tearing it down.
   */
  function pump(): void {
    if (turnRunning || queuedMessages.length === 0) return;
    const sessionCtx = ctx;
    if (!sessionCtx || !tmuxSessionName) return;
    const drained = queuedMessages.splice(0);
    turnRunning = true;
    const promise = (async () => {
      const inputs: string[] = [];
      for (const m of drained) {
        try {
          inputs.push(await sessionCtx.formatInboundContent(m));
        } catch (err) {
          sessionCtx.log(`tui inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (inputs.length === 0) return;
      await runTurn(inputs.join("\n\n"), sessionCtx, drained.length);
    })();
    currentTurnPromise = promise;
    void promise
      .catch((err) => {
        sessionCtx.log(`tui queued turn failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        turnRunning = false;
        currentTurnPromise = null;
        // Drain anything injected while this turn ran. setImmediate keeps the
        // recursion off the stack and lets the just-cleared flags settle.
        setImmediate(pump);
      });
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
      // Hold turnRunning across the whole bootstrap so an inject arriving while
      // the session is still being prepared queues instead of racing pump()
      // into a second turn the instant startClaude sets tmuxSessionName.
      turnRunning = true;
      try {
        await orphanSweep(clientId);
        ctx = sessionCtx;
        cwd = acquireAgentHome(workspaceRoot);

        const payload = (await loadPayload(sessionCtx)) ?? defaultPayload();

        // Per-chat material flows through the unified briefing
        // (`<cwd>/AGENTS.md`, with `<cwd>/CLAUDE.md` symlinked to it). Resolve
        // chat-context and source repos BEFORE bootstrap so the briefing the
        // shared `ensureAgentBootstrap` materialises is fully populated; claude
        // then reads CLAUDE.md once on spawn via `--setting-sources project`.
        chatContextForPrompt = await fetchChatContextOrLog(sessionCtx);
        sourceReposForPrompt = await prepareSourceRepos({
          workspace: cwd,
          payload,
          sessionCtx,
          gitMirrorManager,
          agentName,
        });
        ensureAgentBootstrap({
          workspace: cwd,
          sessionCtx,
          contextTreePath,
          briefing: buildBriefing(sessionCtx, payload, cwd),
        });
        markWorkspaceInitComplete(cwd);

        const sessionId = await startClaude({ sessionCtx, resumeSessionId: null });

        const inputText = await sessionCtx.formatInboundContent(message);
        currentTurnPromise = runTurn(inputText, sessionCtx, 1);
        try {
          await currentTurnPromise;
        } finally {
          currentTurnPromise = null;
        }
        return sessionId;
      } finally {
        turnRunning = false;
        // Drain any messages injected during bootstrap / the first turn.
        setImmediate(pump);
      }
    },

    async resume(message, sessionId, sessionCtx) {
      turnRunning = true;
      try {
        await orphanSweep(clientId);
        ctx = sessionCtx;
        cwd = acquireAgentHome(workspaceRoot);

        const payload = (await loadPayload(sessionCtx)) ?? defaultPayload();

        chatContextForPrompt = await fetchChatContextOrLog(sessionCtx);
        sourceReposForPrompt = await prepareSourceRepos({
          workspace: cwd,
          payload,
          sessionCtx,
          gitMirrorManager,
          agentName,
        });
        // Same shared bootstrap as start(): ensureAgentBootstrap handles the
        // sentinel + Context-Tree/CLI drift internally, so a stale or failed
        // integration is re-run on resume instead of being skipped.
        ensureAgentBootstrap({
          workspace: cwd,
          sessionCtx,
          contextTreePath,
          briefing: buildBriefing(sessionCtx, payload, cwd),
        });
        markWorkspaceInitComplete(cwd);

        const restartedId = await startClaude({ sessionCtx, resumeSessionId: sessionId });

        if (message) {
          const inputText = await sessionCtx.formatInboundContent(message);
          currentTurnPromise = runTurn(inputText, sessionCtx, 1);
          try {
            await currentTurnPromise;
          } finally {
            currentTurnPromise = null;
          }
        }
        return restartedId;
      } finally {
        turnRunning = false;
        setImmediate(pump);
      }
    },

    inject(message) {
      // Always enqueue, then let the single serialised pump() decide when to
      // run. This removes the prior races where an inject arriving in the
      // narrow window around turn completion / startup could either start a
      // second concurrent turn or be stranded with no drain scheduled.
      queuedMessages.push(message);
      pump();
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
