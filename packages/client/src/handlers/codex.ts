import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRuntimeConfigPayload, deriveRepoLocalPath, type SessionEvent } from "@first-tree/shared";
import { Codex, type Input, type Thread, type ThreadItem, type ThreadOptions } from "@openai/codex-sdk";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import {
  bootstrapWorkspace,
  buildChatSystemPrompt,
  deepEqualIdentity,
  FIRST_TREE_WORKSPACE_MARKER,
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
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { acquireAgentHome, INIT_COMPLETE_SENTINEL_REL, markWorkspaceInitComplete } from "../runtime/workspace.js";
import { withWorktreePathLock } from "../runtime/worktree-mutex.js";

/**
 * Codex SDK does not export its `CodexConfigObject` type, so reproduce the
 * minimal shape we need (`mcp_servers.<name>.{...}`, `project_root_markers`).
 * Mirrors the recursive structure from the SDK's `dist/index.d.ts`.
 */
type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
type CodexConfigObject = { [key: string]: CodexConfigValue };

const ASSISTANT_TEXT_EVENT_LIMIT = 8000;
const RESULT_PREVIEW_LIMIT = 400;

type Worktree = { url: string; path: string; branchName: string };

/**
 * Build the per-turn `ThreadOptions` Codex consumes. Exported so unit tests
 * can lock the auth-mode-friendly defaults (notably `model` only set when
 * the operator chose one).
 */
export function buildCodexThreadOptions(payload: AgentRuntimeConfigPayload, workspaceCwd: string): ThreadOptions {
  const additionalDirectories: string[] = [];
  for (const repo of payload.gitRepos) {
    const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
    if (!localPath) continue;
    // Per agent-session-cwd-redesign (2026-05-22 redesign): predeclared
    // source repos live at the TOP LEVEL of the agent home — no `worktrees/`
    // prefix. Codex's sandbox `workingDirectory` already covers `<cwd>` and
    // everything under it (including agent-on-demand `worktrees/<name>/`),
    // so this entry is technically redundant; we keep it for parity with
    // earlier behavior + to make the allowlist explicit for ops.
    additionalDirectories.push(resolveGitRepoTargetPath(workspaceCwd, localPath));
  }
  // Only pin a model when the operator explicitly set one in the agent
  // config — leaving it unset lets the Codex CLI choose a default that
  // matches the user's auth mode (e.g. ChatGPT-account auth rejects the
  // `gpt-5-codex` family, while API-key auth accepts it). Hard-coding a
  // default here would force one auth mode and silently fail on the other.
  const opts: ThreadOptions = {
    workingDirectory: workspaceCwd,
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
    webSearchEnabled: false,
    additionalDirectories,
  };
  if (payload.model) opts.model = payload.model;
  return opts;
}

/**
 * Codex Handler — session-oriented handler using `@openai/codex-sdk`.
 *
 * Each instance owns one Thread for one chat. Each turn is a fresh
 * `runStreamed()` call (Codex CLI is run-to-completion per turn). Inject
 * during an active turn buffers messages and runs them as a follow-up turn
 * the moment the current one completes.
 *
 * Key footguns observed end-to-end (private plan §10.7):
 *   - F1: providing `env` to Codex SDK does NOT inherit `process.env`; we
 *         explicitly merge.
 *   - F2: `resumeThread(id)` does NOT inherit `ThreadOptions`; we re-pass
 *         them every time.
 *   - F3: `modelReasoningEffort: "minimal"` is incompatible with default
 *         tools; we default to `"high"` with `webSearchEnabled: false`.
 *   - F6: `Thread` has no close/dispose — shutdown is exclusively
 *         `AbortController.abort()`.
 */
export const createCodexHandler: HandlerFactory = (config) => {
  const workspaceRoot = config.workspaceRoot as string;
  const agentConfigCache = (config.agentConfigCache as AgentConfigCache | undefined) ?? null;
  const gitMirrorManager = (config.gitMirrorManager as GitMirrorManager | undefined) ?? null;
  const contextTreePath = (config.contextTreePath as string | undefined) ?? null;
  const contextTreeRepoUrl = (config.contextTreeRepoUrl as string | undefined) ?? null;
  const agentName = (config.agentName as string | undefined) ?? null;

  let cwd: string | null = null;
  let codex: Codex | null = null;
  let thread: Thread | null = null;
  let threadId: string | null = null;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let ctx: SessionContext | null = null;
  let drainScheduled = false;
  const queuedMessages: SessionMessage[] = [];
  const ownedWorktrees: Worktree[] = [];
  /**
   * Predeclared source repos materialised by `prepareSourceRepos`. Surfaced
   * in the per-session AGENTS.md so the LLM knows the absolute paths.
   */
  let sourceReposForPrompt: PredeclaredSourceRepo[] = [];

  function buildEnv(sessionCtx: SessionContext): Record<string, string> {
    // Footgun F1: when `CodexOptions.env` is provided the SDK does NOT
    // inherit `process.env`, so HOME/PATH/etc. would be missing. Start by
    // explicitly cloning every defined parent var.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    const payload = agentConfigCache?.get(sessionCtx.agent.agentId)?.payload;
    if (payload) {
      for (const e of payload.env) env[e.key] = e.value;
    }
    const merged = sessionCtx.buildAgentEnv(env);
    // The Hub envelope returns `Record<string, string | undefined>`; trim out
    // undefined values so the SDK doesn't see them.
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(merged)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  function buildCodexConfig(payload: AgentRuntimeConfigPayload): CodexConfigObject {
    const cfg: CodexConfigObject = {
      // Gap-2: anchor codex's project-root walk-up at the workspace marker
      // we wrote in bootstrap, so `AGENTS.md` is read from this workspace
      // instead of leaking up to the operator's repo or HOME.
      project_root_markers: [FIRST_TREE_WORKSPACE_MARKER],
    };
    if (payload.mcpServers.length === 0) return cfg;

    const mcpServers: CodexConfigObject = {};
    for (const m of payload.mcpServers) {
      if (m.transport === "stdio") {
        mcpServers[m.name] = { command: m.command, args: m.args ?? [] };
      } else {
        // http / sse — codex's TOML schema accepts url + optional headers.
        const entry: CodexConfigObject = { url: m.url };
        if (m.headers) entry.headers = m.headers;
        mcpServers[m.name] = entry;
      }
    }
    cfg.mcp_servers = mcpServers;
    return cfg;
  }

  function buildAgentBriefing(
    payload: AgentRuntimeConfigPayload,
    chatContext: ChatContext | undefined,
    workspaceCwd: string,
  ): string {
    const lines: string[] = [];
    lines.push("# Agent Briefing");
    lines.push("");
    if (payload.prompt.append.trim()) {
      lines.push(payload.prompt.append.trim());
      lines.push("");
    }
    // Per agent-session-cwd-redesign: the Claude Code handler injects the
    // working-directory convention + worktree list + chat context via the
    // SDK's `systemPrompt.append`. Codex has no equivalent option, so we
    // serialise the same block into AGENTS.md instead. The codex CLI reads
    // AGENTS.md once at thread startup, so concurrent sessions for the same
    // agent only race during the short window between bootstrap and CLI
    // launch — accepted under proposal §⓪.3.
    const perChatBlock = buildChatSystemPrompt({
      agentHome: workspaceCwd,
      chatContext,
      sourceRepos: sourceReposForPrompt,
    }).trim();
    if (perChatBlock.length > 0) {
      lines.push(perChatBlock);
      lines.push("");
    }
    lines.push("Refer to `.agent/identity.json` for your agent identity, `.agent/tools.md` for the");
    lines.push("first-tree SDK reference, and `.agent/context/` for organisational context");
    lines.push("(when configured).");
    return lines.join("\n").concat("\n");
  }

  /**
   * Best-effort chat-context fetch for the identity-injection path. Failures
   * are logged but never bubble — bootstrap continues with `undefined`.
   */
  async function fetchChatContextOrLog(sessionCtx: SessionContext): Promise<ChatContext | undefined> {
    try {
      return await fetchChatContext(sessionCtx.sdk, sessionCtx.chatId, sessionCtx.agent);
    } catch (err) {
      sessionCtx.log(`fetchChatContext failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  function toCodexInput(message: SessionMessage, sessionCtx: SessionContext): Promise<Input> {
    return sessionCtx.formatInboundContent(message).then((text) => text);
  }

  // NOTE: codex's stream exposes only `command_execution` (shell) items — it
  // cannot cleanly tell which Context Tree node a turn read without parsing
  // shell commands. Rather than emit a fake per-turn signal (the old
  // `emitContextTreeUsage` did), codex produces NO `context_tree_usage` events.
  // Precise codex tree-read tracking is a known gap (P1). See the claude-code
  // handler's tool-call processor for the real per-read signal.

  async function prepareSourceRepos(
    payload: AgentRuntimeConfigPayload,
    workspaceCwd: string,
    sessionCtx: SessionContext,
  ): Promise<void> {
    // Reset the prompt-facing list so a config change between sessions is
    // reflected on the next `buildAgentBriefing` call.
    sourceReposForPrompt = [];
    if (!gitMirrorManager) return;

    const branchAgentKey = agentName ?? sessionCtx.agent.agentId;
    for (const repo of payload.gitRepos) {
      const localPath = repo.localPath ?? deriveRepoLocalPath(repo.url);
      if (!localPath) continue;
      // Per agent-session-cwd-redesign (2026-05-22 redesign): predeclared
      // source repos live at the TOP LEVEL of the agent home — NOT under
      // `worktrees/`. The `worktrees/` subdir is reserved for on-demand
      // worktrees the agent itself creates per task.
      const targetPath = resolveGitRepoTargetPath(workspaceCwd, localPath);
      try {
        await gitMirrorManager.ensureMirror(repo.url);
        await gitMirrorManager.fetchMirror(repo.url);

        // Mirror claude-code's reuse contract (PR #506 review B2): only
        // reuse when the target IS a Hub-managed worktree, and surface a
        // deterministic branchName so the prompt block stays consistent
        // across sessions. Without the `isHubWorktreeMarker` check, an
        // operator-placed directory would be silently reused; without the
        // deterministic branch derivation, codex's "Source Repositories"
        // prompt section would lose the `branch=` field on every reuse.
        const branchName = await withWorktreePathLock(targetPath, async () => {
          if (existsSync(targetPath)) {
            if (isHubWorktreeMarker(targetPath)) {
              sessionCtx.log(`Git: reusing existing source repo at ${localPath}`);
              return deriveSessionBranchName(branchAgentKey, branchAgentKey, repo.url);
            }
            // Path occupied by something we didn't create — log so the
            // operator can find this in the codex log when `createWorktree`
            // throws on the next line (S1 in PR #506 review).
            sessionCtx.log(
              `Git: source-repo target ${localPath} occupied by a non-Hub directory; ` +
                "createWorktree will likely fail",
            );
          }
          const created = await gitMirrorManager.createWorktree({
            url: repo.url,
            ref: repo.ref,
            targetPath,
            sessionKey: branchAgentKey,
            agentName: branchAgentKey,
          });
          return created.branchName;
        });

        // Shared resource — DO NOT track in ownedWorktrees (which the legacy
        // shutdown path used to schedule removal).
        sourceReposForPrompt.push({
          absolutePath: targetPath,
          url: repo.url,
          ...(repo.ref ? { ref: repo.ref } : {}),
          branch: branchName,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx?.log(`codex git materialisation skipped (${repo.url}): ${msg}`);
      }
    }
  }

  function emitToolCall(
    sessionCtx: SessionContext,
    payload: {
      toolUseId: string;
      name: string;
      args: unknown;
      status: "ok" | "error" | "pending";
      resultPreview?: string;
    },
  ): void {
    const event: SessionEvent = {
      kind: "tool_call",
      payload: {
        toolUseId: payload.toolUseId,
        name: payload.name,
        args: payload.args,
        status: payload.status,
        ...(payload.resultPreview ? { resultPreview: payload.resultPreview.slice(0, RESULT_PREVIEW_LIMIT) } : {}),
      },
    };
    sessionCtx.emitEvent(event);
  }

  /**
   * Translate one terminal `item.completed` payload into the runtime's event
   * stream and, when the item is the assistant's final message, return the
   * raw text so `runTurn` can stitch the per-turn reply together.
   */
  function processItem(item: ThreadItem, sessionCtx: SessionContext): string {
    switch (item.type) {
      case "agent_message": {
        // Skip whitespace-only assistant messages — they'd otherwise clutter
        // the events stream with empty `assistant_text` rows. Mirrors the
        // claude-code handler's `text.trim()` guard.
        if (!item.text.trim()) return "";
        sessionCtx.emitEvent({
          kind: "assistant_text",
          payload: { text: item.text.slice(0, ASSISTANT_TEXT_EVENT_LIMIT) },
        });
        return item.text;
      }
      case "command_execution": {
        const status =
          item.status === "completed"
            ? ("ok" as const)
            : item.status === "failed"
              ? ("error" as const)
              : ("pending" as const);
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "command",
          args: { command: item.command },
          status,
          resultPreview: item.aggregated_output,
        });
        return "";
      }
      case "file_change": {
        const status = item.status === "completed" ? ("ok" as const) : ("error" as const);
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "file_change",
          args: { changes: item.changes },
          status,
        });
        return "";
      }
      case "mcp_tool_call": {
        const status =
          item.status === "completed"
            ? ("ok" as const)
            : item.status === "failed"
              ? ("error" as const)
              : ("pending" as const);
        const resultPreview = item.error
          ? `error: ${item.error.message}`
          : item.result
            ? JSON.stringify(item.result.structured_content ?? item.result.content)
            : undefined;
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: `mcp:${item.server}/${item.tool}`,
          args: item.arguments,
          status,
          resultPreview,
        });
        return "";
      }
      case "web_search": {
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "web_search",
          args: { query: item.query },
          status: "ok",
        });
        return "";
      }
      case "todo_list": {
        // Codex's running plan / scratchpad — render as a tool_call so the UI
        // surfaces it without needing a dedicated event kind.
        emitToolCall(sessionCtx, {
          toolUseId: item.id,
          name: "todo_list",
          args: { items: item.items },
          status: "ok",
        });
        return "";
      }
      case "reasoning": {
        // Hide reasoning content for parity with how claude-code suppresses
        // thinking blocks; surface a presence-only marker instead.
        sessionCtx.emitEvent({ kind: "thinking", payload: {} });
        return "";
      }
      case "error": {
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "tool", message: item.message },
        });
        return "";
      }
      default:
        return "";
    }
  }

  async function runTurn(input: Input, sessionCtx: SessionContext): Promise<void> {
    const activeThread = thread;
    if (!activeThread) return;

    const abort = new AbortController();
    currentAbort = abort;
    sessionCtx.setRuntimeState("working");

    // Emit exactly one `turn_end` per turn, after `forwardResult` resolves —
    // mirrors claude-code so admin events + completion bookkeeping reflect
    // actual delivery, not just SDK turn termination. `turn.completed` /
    // `turn.failed` only flip the local status here; the emit happens below.
    const assistantTexts: string[] = [];
    let turnFailed = false;
    const promise = (async () => {
      try {
        const streamed = await activeThread.runStreamed(input, { signal: abort.signal });
        for await (const event of streamed.events) {
          if (abort.signal.aborted) break;
          sessionCtx.touch();
          if (event.type === "thread.started") {
            threadId = event.thread_id;
          } else if (event.type === "turn.started") {
            // No-op — runtime state already "working".
          } else if (event.type === "item.completed") {
            const text = processItem(event.item, sessionCtx);
            if (text) assistantTexts.push(text);
          } else if (event.type === "item.started" || event.type === "item.updated") {
            // Stream-only intermediate states — claude-code likewise emits
            // events on terminal items only; codex's run-to-completion model
            // means the terminal item carries the full payload.
          } else if (event.type === "turn.completed") {
            // Status-only — `turn_end` is emitted after forwardResult below.
          } else if (event.type === "turn.failed") {
            turnFailed = true;
            sessionCtx.emitEvent({
              kind: "error",
              payload: { source: "sdk", message: event.error.message },
            });
          } else if (event.type === "error") {
            sessionCtx.emitEvent({
              kind: "error",
              payload: { source: "sdk", message: event.message },
            });
          }
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        turnFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message: msg } });
      }
    })();

    currentTurnPromise = promise;
    try {
      await promise;
    } finally {
      currentAbort = null;
      currentTurnPromise = null;
    }

    if (abort.signal.aborted) {
      // Suspend/shutdown raced ahead — let the abort handler set state.
      return;
    }

    // `\n\n` between assistant messages so multi-message turns aren't fused
    // into one blob (Codex can emit several `agent_message` items in a turn).
    const accumulated = assistantTexts.join("\n\n");

    let forwardFailed = false;
    if (accumulated.trim()) {
      try {
        await sessionCtx.forwardResult(accumulated);
      } catch (err) {
        forwardFailed = true;
        const msg = err instanceof Error ? err.message : String(err);
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "runtime", message: `forwardResult failed: ${msg}` },
        });
      }
    }

    const succeeded = !turnFailed && !forwardFailed;
    sessionCtx.emitEvent({
      kind: "turn_end",
      payload: { status: succeeded ? "success" : "error" },
    });
    sessionCtx.setRuntimeState("idle");

    // Drain queued messages — schedules at most one follow-up at a time so
    // a runaway inject loop can't recurse into stack overflow.
    if (queuedMessages.length > 0 && !drainScheduled) {
      drainScheduled = true;
      setImmediate(() => {
        drainScheduled = false;
        const drained = queuedMessages.splice(0);
        if (drained.length === 0 || !ctx || !thread) return;
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
        sessionCtx.log(`codex inject formatInboundContent failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (inputs.length === 0) return;
    await runTurn(inputs.join("\n\n"), sessionCtx);
  }

  /** Install the first-tree skill + binding block; no-op when context tree is unconfigured. */
  function ensureFirstTreeBinding(workspace: string, sessionCtx: SessionContext): void {
    if (!contextTreePath) return;
    installFirstTreeIntegration({
      workspacePath: workspace,
      contextTreePath,
      // Workspace id identifies the agent home (per agent-session-cwd-
      // redesign), not the chat — so the first-tree skill installs once and
      // remains stable across every chat session of this agent.
      workspaceId: agentName ?? sessionCtx.agent.agentId,
      treeRepoUrl: contextTreeRepoUrl ?? undefined,
      log: (msg) => sessionCtx.log(msg),
    });
  }

  /**
   * Run the expensive first-time bootstrap (full stable layout + `first-tree
   * tree integrate` shell-out + briefing write) or — when the sentinel and
   * Context-Tree HEAD match the cached state — only refresh the per-chat
   * briefing (AGENTS.md). Mirrors the claude-code handler's
   * `ensureAgentBootstrap` so both handlers converge on identical per-agent-
   * home bootstrap semantics.
   *
   * 🔥 RACE WINDOW (proposal §⓪.3 accepted): unlike claude-code's
   * `systemPrompt.append`, codex has no per-turn prompt injection. We
   * therefore write the per-chat block (Current Chat Context, source repo
   * list) **into AGENTS.md on every start/resume**. Two chats starting
   * concurrently for the same agent can clobber each other's briefing
   * between the write and the codex CLI's first read — accepted in the
   * proposal because the window is short (millis between bootstrap and CLI
   * spawn). If you are debugging "wrong chat context surfaces in codex",
   * look here first.
   *
   * Note: AGENTS.md is **always rewritten** because it carries per-chat
   * content (Current Chat Context, predeclared worktree list) and codex has
   * no equivalent of Claude SDK's `appendSystemPrompt`.
   */
  function ensureCodexBootstrap(workspace: string, sessionCtx: SessionContext, briefing: string): void {
    const sentinelPresent = existsSync(join(workspace, INIT_COMPLETE_SENTINEL_REL));
    const currentTreeHead = readContextTreeHead(contextTreePath);
    const cachedTreeHead = readCachedContextTreeHead(workspace);
    if (cachedTreeHead !== null && currentTreeHead === null) {
      // PR #506 review Q1: drift detection silently fails when the head
      // probe errors out — log the asymmetry so it isn't invisible.
      sessionCtx.log(
        `Context Tree HEAD probe returned null while cached value is ` +
          `${cachedTreeHead.slice(0, 7)}; drift detection bypassed for this start`,
      );
    }
    const treeDrifted = currentTreeHead !== null && cachedTreeHead !== null && currentTreeHead !== cachedTreeHead;

    if (sentinelPresent && !treeDrifted) {
      // Fast path: identity hash check, briefing rewrite, no integrate.
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
      let identityMatches = false;
      if (existsSync(identityPath)) {
        try {
          identityMatches = deepEqualIdentity(JSON.parse(readFileSync(identityPath, "utf-8")), desired);
        } catch {
          identityMatches = false;
        }
      }
      // Bootstrap writes identity, context dir, tools.md, briefing (AGENTS.md),
      // and the boundary marker. We always call it — even when identity
      // matches — because briefing changes every session (per-chat block).
      bootstrapWorkspace({
        workspacePath: workspace,
        identity: sessionCtx.agent,
        contextTreePath,
        serverUrl: sessionCtx.sdk.serverUrl,
        briefing: { format: "agents-md", content: briefing },
      });
      if (!identityMatches) {
        sessionCtx.log("Agent identity drift detected; .agent/ refreshed");
      }
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
      briefing: { format: "agents-md", content: briefing },
    });
    ensureFirstTreeBinding(workspace, sessionCtx);
    writeContextTreeHead(workspace, currentTreeHead);
  }

  return {
    async start(message, sessionCtx) {
      ctx = sessionCtx;
      // Per agent-session-cwd-redesign: cwd is the per-agent home, shared
      // by every chat session for this agent.
      cwd = acquireAgentHome(workspaceRoot);

      let payload: AgentRuntimeConfigPayload | null = null;
      if (agentConfigCache) {
        payload = (await agentConfigCache.refresh(sessionCtx.agent.agentId)).payload;
      }
      if (!payload) {
        payload = {
          kind: "codex",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
        };
      }

      const chatContext = await fetchChatContextOrLog(sessionCtx);

      // gitRepos first so the per-chat briefing can list the predeclared
      // worktree paths the agent should know about.
      await prepareSourceRepos(payload, cwd, sessionCtx);

      const briefing = buildAgentBriefing(payload, chatContext, cwd);
      ensureCodexBootstrap(cwd, sessionCtx, briefing);
      markWorkspaceInitComplete(cwd);

      codex = new Codex({ env: buildEnv(sessionCtx), config: buildCodexConfig(payload) });
      thread = codex.startThread(buildCodexThreadOptions(payload, cwd));

      const input = await toCodexInput(message, sessionCtx);
      await runTurn(input, sessionCtx);

      // Codex assigns thread_id via `thread.started` during the first turn;
      // fall back to whatever `Thread` exposes if the event was missed.
      if (!threadId) {
        threadId = thread.id ?? null;
      }
      if (!threadId) {
        throw new Error("codex did not assign a thread id during the first turn");
      }
      return threadId;
    },

    async resume(message, sessionId, sessionCtx) {
      ctx = sessionCtx;
      cwd = acquireAgentHome(workspaceRoot);

      let payload: AgentRuntimeConfigPayload | null = null;
      if (agentConfigCache) {
        payload = (await agentConfigCache.refresh(sessionCtx.agent.agentId)).payload;
      }
      if (!payload) {
        payload = {
          kind: "codex",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
        };
      }

      // Re-fetch chat-context every resume so newly-joined participants
      // surface in AGENTS.md. The sentinel still gates the expensive
      // `first-tree tree integrate` shell-out.
      const chatContext = await fetchChatContextOrLog(sessionCtx);

      await prepareSourceRepos(payload, cwd, sessionCtx);

      const briefing = buildAgentBriefing(payload, chatContext, cwd);
      ensureCodexBootstrap(cwd, sessionCtx, briefing);
      markWorkspaceInitComplete(cwd);

      codex = new Codex({ env: buildEnv(sessionCtx), config: buildCodexConfig(payload) });
      // Footgun F2: resumeThread does NOT inherit first-call ThreadOptions —
      // re-pass them every time.
      thread = codex.resumeThread(sessionId, buildCodexThreadOptions(payload, cwd));
      threadId = sessionId;

      if (message) {
        const input = await toCodexInput(message, sessionCtx);
        await runTurn(input, sessionCtx);
      }
      return sessionId;
    },

    inject(message) {
      // Fire-and-forget — Codex turns are run-to-completion, so the message
      // is buffered and drained on the next available turn. If the thread
      // isn't running anything right now, schedule a turn immediately.
      if (currentTurnPromise) {
        queuedMessages.push(message);
        return;
      }
      const sessionCtx = ctx;
      if (!sessionCtx || !thread) return;
      void (async () => {
        try {
          const input = await toCodexInput(message, sessionCtx);
          await runTurn(input, sessionCtx);
        } catch (err) {
          sessionCtx.log(`codex inject failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
    },

    async suspend() {
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        // swallowed — abort raises AbortError on the streaming iterator
      }
      currentAbort = null;
      currentTurnPromise = null;
      thread = null;
      codex = null;
    },

    async shutdown() {
      // suspend() releases the active turn. Per agent-session-cwd-redesign
      // we no longer rm the cwd or auto-remove predeclared worktrees — both
      // are agent-scoped persistent resources shared across chats.
      currentAbort?.abort();
      try {
        await currentTurnPromise;
      } catch {
        /*ignore*/
      }
      currentAbort = null;
      currentTurnPromise = null;
      thread = null;
      codex = null;

      // Only session-private worktrees (currently none — predeclared ones
      // intentionally skip `ownedWorktrees.push`) get torn down here. Future
      // ad-hoc worktree creation sites can opt in by pushing to
      // `ownedWorktrees`.
      if (gitMirrorManager) {
        for (const wt of ownedWorktrees) {
          try {
            await gitMirrorManager.removeWorktree({ url: wt.url, path: wt.path, branchName: wt.branchName });
          } catch (err) {
            ctx?.log(`codex worktree cleanup failed (${wt.path}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        ownedWorktrees.length = 0;
      }

      // cwd points at the persistent agent home — NO rmSync. The legacy
      // behaviour that wiped per-chat workspaces went away with the cwd
      // model change.
      cwd = null;
      threadId = null;
      ctx = null;
      queuedMessages.length = 0;
    },
  } satisfies AgentHandler;
};
