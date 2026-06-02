import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentRuntimeConfigPayload, deriveRepoLocalPath, type SessionEvent } from "@first-tree/shared";
import { Codex, type Input, type Thread, type ThreadItem, type ThreadOptions, type Usage } from "@openai/codex-sdk";
import type { AgentConfigCache } from "../runtime/agent-config-cache.js";
import {
  bootstrapWorkspace,
  buildChatSystemPrompt,
  deepEqualIdentity,
  FIRST_TREE_WORKSPACE_MARKER,
  generateToolsDoc,
  installCoreSkills,
  installFirstTreeIntegration,
  isHubWorktreeMarker,
  type PredeclaredSourceRepo,
  readCachedBundledCliVersion,
  readCachedContextTreeHead,
  readContextTreeHead,
  resolveBundledCliVersion,
  writeBundledCliVersion,
  writeContextTreeHead,
} from "../runtime/bootstrap.js";
import { type ChatContext, fetchChatContext } from "../runtime/chat-context.js";
import { resolveGitRepoTargetPath } from "../runtime/git-local-path.js";
import { deriveSessionBranchName, type GitMirrorManager } from "../runtime/git-mirror-manager.js";
import type { AgentHandler, HandlerFactory, SessionContext, SessionMessage } from "../runtime/handler.js";
import { acquireAgentHome, INIT_COMPLETE_SENTINEL_REL, markWorkspaceInitComplete } from "../runtime/workspace.js";
import { withWorktreePathLock } from "../runtime/worktree-mutex.js";
import { formatAuthHint, isCodexAuthError } from "./auth-error-hint.js";

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
 * Turn-level retry budget for transient codex failures.
 *
 * Total attempts = MAX_TURN_RETRIES + 1 (i.e. 1 initial + 2 retries = 3 tries).
 * Backoff is `RETRY_BASE_MS * RETRY_MULTIPLIER^attempt`, so the schedule is
 * 500 ms → 1500 ms before the third attempt — matches the order of magnitude
 * of the SDK fetch-retry layer (`sdk-retry.test.ts`) without falling into the
 * same band that PostgreSQL LISTEN/NOTIFY uses for inbox redelivery.
 *
 * **Layering with `FirstTreeHubSDK` fetch retry (PR #600 review nit #3):**
 * this counter sits on top of the SDK's internal `doFetch` retry (3 tries,
 * 0/500/1000 ms) AND on top of whatever `@openai/codex-sdk` does inside its
 * child-process call. Worst-case attempts per turn ≈ this layer (3) × inner
 * SDK fetch retry (3) = ~9 model invocations and a wall-clock ceiling near
 * `RETRY_BASE_MS * RETRY_MULTIPLIER^MAX_TURN_RETRIES + sum(inner backoffs)`.
 * Operators looking at long-tail latency / retry logs should know both
 * layers exist before tuning either.
 *
 * Retries fire ONLY when (a) the error message looks transient (see
 * `isTransientCodexErrorMessage`) AND (b) no user-visible event has been
 * emitted yet for this turn (see `isUserVisibleItem`). Once the agent has
 * said something or run a tool, re-running the turn would double-emit those
 * items in the chat timeline — not acceptable.
 */
const MAX_TURN_RETRIES = 2;
const RETRY_BASE_MS = 500;
const RETRY_MULTIPLIER = 3;

/**
 * Concurrent-write detection window for the per-chat AGENTS.md briefing.
 *
 * Codex CLI reads AGENTS.md once at thread startup; the handler rewrites it
 * on every start/resume because there is no per-turn prompt-injection API
 * (see proposal §⓪.3 risk acceptance / §④ race-window decision). Two chats
 * starting for the same agent within this window almost certainly raced —
 * the second writer clobbered the first briefing before the codex CLI got
 * to read it. We log instead of locking because the operational signal
 * ("wrong chat context surfaces in codex") is the actionable thing; the
 * fix lives upstream (per-turn prompt API).
 *
 * **1000 ms chosen empirically (PR #600 review nit #2):** the bootstrap
 * pipeline (git mirror prepare → `bootstrapWorkspace` → briefing rewrite)
 * runs in roughly 200 ms-1 s when the mirror is warm. A tighter window
 * (the original 100 ms) systematically MISSED the most dangerous form of
 * the race — two chats triggering `ensureCodexBootstrap` within the same
 * bootstrap envelope — so we widen to cover that. Conversely, two writes
 * spaced more than 1 s apart are unlikely to share a CLI read window. We
 * accept a small chance of false positives (e.g. fast resume followed by
 * fast resume from the same chat) over false negatives, because the log
 * line is diagnostic-only — no behaviour change.
 */
const AGENTS_MD_RACE_WINDOW_MS = 1000;

/**
 * Module-level so the race detector spans every handler instance for the
 * same agent home (each chat creates its own handler). Cleared per-test
 * via `__resetCodexHandlerStateForTests`.
 */
const lastAgentsMdWriteAt = new Map<string, number>();

/** Test-only: reset module-level race-detector state between vitest cases. */
export function __resetCodexHandlerStateForTests(): void {
  lastAgentsMdWriteAt.clear();
}

/**
 * Record an AGENTS.md write and surface a warning when one fires inside the
 * `AGENTS_MD_RACE_WINDOW_MS` of the previous write for the same workspace —
 * the codex CLI reads AGENTS.md once at thread startup, so two writers
 * inside this window mean the second one almost certainly clobbered the
 * first briefing before the CLI got to read it. Exported so the behaviour
 * is unit-testable without going through the full handler bootstrap path.
 */
export function detectAgentsMdConcurrentWrite(workspace: string, now: number, log: (msg: string) => void): void {
  const prevWrite = lastAgentsMdWriteAt.get(workspace);
  if (prevWrite !== undefined && now - prevWrite < AGENTS_MD_RACE_WINDOW_MS) {
    log(
      `codex AGENTS.md concurrent write detected workspace=${workspace} ` +
        `gap_ms=${now - prevWrite} — another chat may have overwritten this briefing ` +
        `before codex CLI read it (proposal §⓪.3 race window). ` +
        `If chat-context surfaces wrong agent state, this is the cause.`,
    );
  }
  lastAgentsMdWriteAt.set(workspace, now);
}

/**
 * HTTP status-code matchers anchored at word boundaries so unrelated
 * numeric IDs ("request id 5023", "job_id=5001", "context window 4012")
 * don't smuggle a false-positive match through `includes("500")` etc.
 * See PR #600 review nit #1.
 */
const AUTH_HTTP_CODE_RE = /\b(401|403)\b/;
const TRANSIENT_HTTP_CODE_RE = /\b(500|502|503|504)\b/;

/**
 * Transient-error heuristic for `turn.failed` / SDK throws.
 *
 * The codex SDK surfaces `ThreadError = { message: string }` only — no
 * structured status code or `Retry-After`. We classify by keyword: HTTP 5xx,
 * common network-error mnemonics, and the explicit "overloaded" / "rate
 * limit" phrases the upstream model API uses. Auth, sandbox, and
 * configuration failures are deliberately NOT in this set — retrying them
 * just wastes attempts.
 *
 * Exported for tests so the classifier table is locked behavioural API.
 */
export function isTransientCodexErrorMessage(message: string): boolean {
  const m = message.toLowerCase();
  // Explicit non-retriables — short-circuit so a message like "401:
  // unauthorized after fetch failed" doesn't get retried because of
  // "fetch failed". HTTP codes use \b word boundaries so a `job_id=4012345`
  // / `request id 4019` in the wrapped error doesn't get misclassified as
  // an auth failure (which would silently swallow a real transient).
  if (
    AUTH_HTTP_CODE_RE.test(m) ||
    m.includes("unauthorized") ||
    m.includes("forbidden") ||
    m.includes("invalid api key") ||
    m.includes("invalid_api_key") ||
    m.includes("authentication") ||
    m.includes("context length") ||
    m.includes("context_length") ||
    m.includes("sandbox") ||
    m.includes("approval")
  ) {
    return false;
  }
  return (
    TRANSIENT_HTTP_CODE_RE.test(m) ||
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("overloaded") ||
    m.includes("unavailable") ||
    m.includes("timed out") ||
    m.includes("timeout") ||
    m.includes("fetch failed") ||
    m.includes("network") ||
    m.includes("econnreset") ||
    m.includes("econnrefused") ||
    m.includes("etimedout") ||
    m.includes("epipe")
  );
}

/**
 * Tracks whether re-running this turn would double-emit a chat-visible item.
 * `reasoning` and the bare `error` item are presence-only / diagnostic and
 * safe to re-emit; everything else is rendered in the chat timeline.
 */
function isUserVisibleItem(item: ThreadItem): boolean {
  switch (item.type) {
    case "agent_message":
    case "command_execution":
    case "file_change":
    case "mcp_tool_call":
    case "web_search":
    case "todo_list":
      return true;
    case "reasoning":
    case "error":
      return false;
  }
}

/**
 * Codex's `turn.completed.usage` reports the **cumulative** token usage for
 * the whole thread, not the per-turn delta: on `codex exec resume` the CLI
 * seeds `total_token_usage` from the last `TokenCount` persisted in the
 * rollout (`session/mod.rs::last_token_info_from_rollout`) and keeps adding
 * to it, and the exec JSON layer emits `usage.total` (not `usage.last`). Each
 * First Tree turn is its own `codex exec resume` child, so the value we see
 * grows turn-over-turn (T1, T1+T2, T1+T2+T3, …). Emitting that verbatim makes
 * any consumer that sums `token_usage` events over-count triangularly.
 *
 * This converts the cumulative reading into the per-turn delta the
 * `token_usage` schema expects:
 *   - With a `baseline` (the previous turn's cumulative in this handler
 *     instance): subtract field-by-field, clamped at 0 so a compaction reset
 *     (`fill_to_context_window` lowers the total) under-counts one turn
 *     rather than emitting a negative.
 *   - No baseline + a brand-new thread (`start`): the cumulative IS this
 *     turn, so return it unchanged.
 *   - No baseline + a resumed thread (cold resume after a daemon restart):
 *     the cumulative already folds in prior turns we never observed, so there
 *     is nothing to subtract. Returning `null` skips the emit for exactly one
 *     turn — far better than reporting the whole thread-to-date as one turn.
 *
 * Pure + exported so the delta arithmetic is unit-testable without the full
 * handler bootstrap chain.
 */
export function computePerTurnUsageDelta(
  cumulative: Usage,
  baseline: Usage | null,
  threadIsFresh: boolean,
): Usage | null {
  if (!baseline) {
    return threadIsFresh ? { ...cumulative } : null;
  }
  return {
    input_tokens: Math.max(0, cumulative.input_tokens - baseline.input_tokens),
    cached_input_tokens: Math.max(0, cumulative.cached_input_tokens - baseline.cached_input_tokens),
    output_tokens: Math.max(0, cumulative.output_tokens - baseline.output_tokens),
    reasoning_output_tokens: Math.max(0, cumulative.reasoning_output_tokens - baseline.reasoning_output_tokens),
  };
}

/**
 * Abort-aware sleep. Resolves on either the timer firing or the abort
 * signal; on abort, rejects with `AbortError` so the caller can fall back
 * to the abort-aware code path in `runTurn` instead of running another
 * attempt against a cancelled turn.
 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

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
  // Sandbox: codex is the agent's primary local-execution surface (docker,
  // cross-directory writes, host tools all flow through it). `workspace-write`
  // blocks unix sockets outside the workspace (notably ~/.docker/run/docker.sock)
  // and any out-of-tree write the agent legitimately needs. We run with
  // `danger-full-access` and rely on the agent to gate irreversible actions
  // itself instead of a sandbox-level wall.
  const opts: ThreadOptions = {
    workingDirectory: workspaceCwd,
    skipGitRepoCheck: true,
    sandboxMode: "danger-full-access",
    approvalPolicy: "never",
    // Operator-configured reasoning effort. Defaults to "high" (the value this
    // previously hard-coded). The codex variant's enum (low|medium|high|xhigh)
    // is a subset of the SDK's ModelReasoningEffort and deliberately omits
    // "minimal", which is incompatible with the default tool set (footgun F3).
    modelReasoningEffort: payload.kind === "codex" ? payload.reasoningEffort : "high",
    webSearchEnabled: false,
    additionalDirectories,
  };
  if (payload.model) opts.model = payload.model;
  return opts;
}

export function buildCodexAgentBriefing(
  payload: AgentRuntimeConfigPayload,
  chatContext: ChatContext | undefined,
  workspaceCwd: string,
  sourceRepos: PredeclaredSourceRepo[],
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
    sourceRepos,
  }).trim();
  if (perChatBlock.length > 0) {
    lines.push(perChatBlock);
    lines.push("");
  }
  lines.push(generateToolsDoc().trim());
  lines.push("");
  lines.push("Refer to `.agent/identity.json` for your agent identity, and `.agent/context/`");
  lines.push("for organisational context (when configured).");
  return lines.join("\n").concat("\n");
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
  // Best-effort label for the current Codex thread's model — recorded from the
  // last `buildCodexThreadOptions` call so `token_usage` events can carry a
  // model name. The SDK does not echo back the actual model used (the CLI may
  // pick a default when `payload.model` is empty), so this is whatever the
  // operator configured; absence is surfaced as the placeholder below.
  let currentModel = "";
  // Codex reports CUMULATIVE thread usage on every `turn.completed` (see
  // `computePerTurnUsageDelta`). Track the previous turn's cumulative so we
  // can emit the per-turn delta, and whether THIS handler instance opened a
  // brand-new thread (`start`) — only then is the first reading a true
  // single-turn value with a zero baseline. A cold `resume` leaves both unset
  // so the first post-resume turn is skipped rather than over-counted.
  let prevCumulativeUsage: Usage | null = null;
  let threadIsFresh = false;
  let currentAbort: AbortController | null = null;
  let currentTurnPromise: Promise<void> | null = null;
  let ctx: SessionContext | null = null;
  let drainScheduled = false;
  let drainInProgress = false;
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
    // The First Tree envelope returns `Record<string, string | undefined>`; trim out
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
    return buildCodexAgentBriefing(payload, chatContext, workspaceCwd, sourceReposForPrompt);
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
        // reuse when the target IS a First Tree-managed worktree, and surface a
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
              `Git: source-repo target ${localPath} occupied by a non-First Tree directory; ` +
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
   * stream and, when the item is assistant text, return the raw text so
   * `runTurn` can track the SDK-style final response.
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
        // Codex's `~/.codex/auth.json` refresh failures surface here when the
        // SDK bubbles them as item-level errors rather than turn.failed. The
        // raw wording is shaped like "Your access token could not be refreshed
        // because your refresh token was revoked. Please log out and sign in
        // again." — opaque to a First Tree user. Reframe at the boundary so
        // the next step (run `codex login` in their own terminal) is obvious.
        const message = isCodexAuthError(item.message) ? formatAuthHint("codex", item.message) : item.message;
        sessionCtx.emitEvent({
          kind: "error",
          payload: { source: "tool", message },
        });
        return "";
      }
      default:
        return "";
    }
  }

  /**
   * Run one Codex turn.
   *
   * `entryCount` is the number of inbox entries this turn is consuming —
   * always 1 for `start` / `resume` / single-inject paths, and `N` when
   * `mergeAndRun` fuses N queued messages into one input. The runtime acks
   * exactly `entryCount` entries from the chat's in-flight FIFO once the
   * turn closes (markCompleted N). Drift between this number and what the
   * SDK actually consumed loses the per-turn pairing — under-counts leak
   * entries (stay `delivered` server-side until next bind), over-counts
   * ack future turns prematurely (loss on crash).
   */
  async function runTurn(input: Input, sessionCtx: SessionContext, entryCount: number): Promise<void> {
    const activeThread = thread;
    if (!activeThread) return;

    const abort = new AbortController();
    currentAbort = abort;
    sessionCtx.setRuntimeState("working");

    // Emit exactly one `turn_end` per turn, after `forwardResult` resolves —
    // mirrors claude-code so admin events + completion bookkeeping reflect
    // actual delivery, not just SDK turn termination. `turn.completed` /
    // `turn.failed` only flip the local status here; the emit happens below.
    //
    // `userVisibleEmitted` gates the retry path: once we've emitted an
    // assistant_text / tool_call to the chat, re-running the turn would
    // double-render those items, so we stop retrying even if the SDK
    // surfaces a transient `turn.failed`.
    let finalResponse = "";
    let turnFailed = false;
    let userVisibleEmitted = false;
    // Wrapper object so TS doesn't narrow `lastUsage` to `null` based on the
    // synchronous initializer (assignments live inside the IIFE below, which
    // TS' control-flow analysis can't reach — microsoft/TypeScript#9998).
    const usageBox: { value: Usage | null } = { value: null };
    const turnStartedAt = Date.now();
    const promise = (async () => {
      for (let attempt = 0; attempt <= MAX_TURN_RETRIES; attempt++) {
        // Reset per-attempt; finalResponse intentionally persists across
        // attempts only because we abort retries the moment any user-visible
        // item is emitted, so it is empty whenever a retry runs.
        turnFailed = false;
        let retryRequested = false;
        let retryDelay = 0;
        let retryReason = "";

        // Per-attempt child AbortController (PR #600 review nit #4): the
        // codex-sdk Thread exposes no explicit close/cancel beyond the
        // AbortSignal passed to runStreamed. If we `break` out of the
        // for-await on a transient `turn.failed` and reuse the parent
        // signal, the SDK's background generator + child-process stdout
        // reader can keep draining the dead stream until child exit.
        // A fresh child controller per attempt lets us explicitly tear
        // down the previous stream before starting the next, while
        // suspend/shutdown still cascades down via the parent listener.
        const attemptAbort = new AbortController();
        const onParentAbort = (): void => attemptAbort.abort();
        abort.signal.addEventListener("abort", onParentAbort, { once: true });

        try {
          try {
            const streamed = await activeThread.runStreamed(input, { signal: attemptAbort.signal });
            for await (const event of streamed.events) {
              if (attemptAbort.signal.aborted) break;
              sessionCtx.touch();
              if (event.type === "thread.started") {
                threadId = event.thread_id;
              } else if (event.type === "turn.started") {
                // No-op — runtime state already "working".
              } else if (event.type === "item.completed") {
                const text = processItem(event.item, sessionCtx);
                if (text) finalResponse = text;
                if (isUserVisibleItem(event.item)) userVisibleEmitted = true;
              } else if (event.type === "item.started" || event.type === "item.updated") {
                // Stream-only intermediate states — claude-code likewise emits
                // events on terminal items only; codex's run-to-completion model
                // means the terminal item carries the full payload.
              } else if (event.type === "turn.completed") {
                // Capture usage for the post-turn metrics log; `turn_end` is
                // still emitted after forwardResult below.
                usageBox.value = event.usage;
              } else if (event.type === "turn.failed") {
                if (
                  !userVisibleEmitted &&
                  attempt < MAX_TURN_RETRIES &&
                  isTransientCodexErrorMessage(event.error.message)
                ) {
                  retryRequested = true;
                  retryDelay = RETRY_BASE_MS * RETRY_MULTIPLIER ** attempt;
                  retryReason = `turn.failed (transient): ${event.error.message}`;
                  break;
                }
                turnFailed = true;
                const message = isCodexAuthError(event.error.message)
                  ? formatAuthHint("codex", event.error.message)
                  : event.error.message;
                sessionCtx.emitEvent({
                  kind: "error",
                  payload: { source: "sdk", message },
                });
              } else if (event.type === "error") {
                if (!userVisibleEmitted && attempt < MAX_TURN_RETRIES && isTransientCodexErrorMessage(event.message)) {
                  retryRequested = true;
                  retryDelay = RETRY_BASE_MS * RETRY_MULTIPLIER ** attempt;
                  retryReason = `stream error (transient): ${event.message}`;
                  break;
                }
                turnFailed = true;
                const message = isCodexAuthError(event.message)
                  ? formatAuthHint("codex", event.message)
                  : event.message;
                sessionCtx.emitEvent({
                  kind: "error",
                  payload: { source: "sdk", message },
                });
              }
            }
          } catch (err) {
            if (abort.signal.aborted) return;
            const msg = err instanceof Error ? err.message : String(err);
            if (!userVisibleEmitted && attempt < MAX_TURN_RETRIES && isTransientCodexErrorMessage(msg)) {
              retryRequested = true;
              retryDelay = RETRY_BASE_MS * RETRY_MULTIPLIER ** attempt;
              retryReason = `runStreamed threw (transient): ${msg}`;
            } else {
              turnFailed = true;
              const message = isCodexAuthError(msg) ? formatAuthHint("codex", msg) : msg;
              sessionCtx.emitEvent({ kind: "error", payload: { source: "sdk", message } });
            }
          }
        } finally {
          // Detach the parent listener whether we retry or break. Even
          // with `{ once: true }` the listener may never fire (no
          // parent-abort during this attempt) — without removal we'd
          // leak one per attempt for the lifetime of the parent
          // controller (i.e. of this turn).
          abort.signal.removeEventListener("abort", onParentAbort);
        }

        if (!retryRequested) break;
        // Explicit tear-down: kill the previous stream before the backoff
        // sleep so its drain doesn't overlap the next attempt's child
        // process. No-op if the parent already aborted (the listener
        // above already cascaded).
        attemptAbort.abort();
        sessionCtx.log(`codex turn retry ${attempt + 1}/${MAX_TURN_RETRIES + 1} after ${retryDelay}ms; ${retryReason}`);
        try {
          // Sleep on PARENT signal: only suspend/shutdown should cut
          // short the backoff window, not the retry-triggered abort we
          // just fired on the per-attempt controller.
          await sleepWithAbort(retryDelay, abort.signal);
        } catch {
          // AbortError — suspend/shutdown raced ahead; let the abort path
          // handle teardown.
          return;
        }
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

    // Match @openai/codex-sdk's Thread.run() success semantics: when a turn
    // emits several non-empty agent_message items, finalResponse is the latest
    // one. Earlier agent_message items remain live assistant_text progress
    // events only. If the turn failed, do not forward partial text as a final
    // chat message.
    const accumulated = finalResponse;

    let forwardFailed = false;
    if (!turnFailed && accumulated.trim()) {
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
    // Codex reports CUMULATIVE thread usage on `turn.completed`; convert it to
    // the per-turn delta the `token_usage` schema documents before emitting.
    // `usageBox.value` is null when the turn never reached `turn.completed`
    // (abort / unrecoverable failure) — no totals to diff, so leave the
    // baseline untouched and skip both the emit and the log below.
    const cumulativeUsage = usageBox.value;
    const perTurnUsage = cumulativeUsage
      ? computePerTurnUsageDelta(cumulativeUsage, prevCumulativeUsage, threadIsFresh)
      : null;
    if (cumulativeUsage) {
      // Advance the baseline even when `perTurnUsage` is null (the cold-resume
      // first turn): the NEXT turn must diff against this cumulative, not the
      // stale pre-resume value. Clearing `threadIsFresh` makes every later
      // turn take the subtract path.
      prevCumulativeUsage = cumulativeUsage;
      threadIsFresh = false;
    }

    // Emit `token_usage` just before `turn_end` so the wire-order matches the
    // claude-code handler (consumers can group all usage events for a turn
    // between the previous and current `turn_end`).
    if (perTurnUsage) {
      try {
        sessionCtx.emitEvent({
          kind: "token_usage",
          payload: {
            provider: "codex",
            model: currentModel || "codex-default",
            // Codex's `input_tokens` is the TOTAL prompt incl. its cached
            // subset (`codex-rs` derives non_cached = input - cached). The
            // schema's `inputTokens` is the NON-cached portion, disjoint from
            // `cachedInputTokens` — subtract to match the claude-code
            // handler's contract instead of double-counting the cache.
            inputTokens: Math.max(0, perTurnUsage.input_tokens - perTurnUsage.cached_input_tokens),
            cachedInputTokens: perTurnUsage.cached_input_tokens,
            outputTokens: perTurnUsage.output_tokens,
          },
        });
      } catch (err) {
        sessionCtx.log(`Failed to emit token_usage: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    sessionCtx.emitEvent({
      kind: "turn_end",
      payload: { status: succeeded ? "success" : "error" },
    });
    sessionCtx.setRuntimeState("idle");
    // Ack the entries this turn consumed. All four turn outcomes (success,
    // silent / no-text, SDK turn.failed, forwardResult failure) are
    // terminal for this turn — redelivery would either replay an already-
    // delivered reply or re-hit the same failure. Pass `entryCount` so a
    // fused `mergeAndRun` (N injected messages → one turn) acks exactly
    // those N entries and leaves any in-flight entries for the NEXT turn
    // alone.
    sessionCtx.markCompleted(entryCount);

    // Structured usage / timing log — emitted via `sessionCtx.log` rather
    // than a new SessionEvent kind so we stay inside the codex handler
    // (shared schema unchanged). Codex's `high` reasoning + larger context
    // makes per-turn cost 3-5× claude-code at the same input length; without
    // this line operators cannot account for spend per chat. Logs the SAME
    // per-turn delta as the event (non-cached input split out) so the log and
    // the wire agree; `null` for an abort / cold-resume first turn we skip.
    if (perTurnUsage) {
      sessionCtx.log(
        `codex usage chatId=${sessionCtx.chatId} duration_ms=${Date.now() - turnStartedAt} ` +
          `input_tokens=${Math.max(0, perTurnUsage.input_tokens - perTurnUsage.cached_input_tokens)} ` +
          `cached_input_tokens=${perTurnUsage.cached_input_tokens} ` +
          `output_tokens=${perTurnUsage.output_tokens} reasoning_output_tokens=${perTurnUsage.reasoning_output_tokens} ` +
          `status=${succeeded ? "success" : "error"}`,
      );
    }

    scheduleQueuedMessagesDrain();
  }

  function scheduleQueuedMessagesDrain(): void {
    if (drainScheduled || drainInProgress) return;
    if (queuedMessages.length === 0 || !ctx || !thread || currentTurnPromise) return;

    drainScheduled = true;
    setImmediate(() => {
      drainScheduled = false;
      if (drainInProgress || queuedMessages.length === 0 || !ctx || !thread || currentTurnPromise) {
        scheduleQueuedMessagesDrain();
        return;
      }

      const drained = queuedMessages.splice(0);
      const sessionCtx = ctx;
      drainInProgress = true;
      void mergeAndRun(drained, sessionCtx).finally(() => {
        drainInProgress = false;
        scheduleQueuedMessagesDrain();
      });
    });
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
    if (inputs.length === 0) {
      // Every fused message failed `formatInboundContent` — semantically a
      // permanent failure for this batch (redelivery would re-hit the same
      // format errors). Ack the entries so they don't leak in
      // `inFlightEntries` and pile up server-side as `delivered` rows.
      sessionCtx.markCompleted(drained.length);
      return;
    }
    // `drained.length` is the authoritative fused-entry count — formatting
    // a single message could throw (it gets logged and skipped above) but
    // the inbox entry was still pushed at dispatch time, so it must still
    // be acked. Using `inputs.length` here would leak the formatting-failed
    // entry until the next bind reset.
    await runTurn(inputs.join("\n\n"), sessionCtx, drained.length);
  }

  /**
   * Install the first-tree skill + binding block; no-op when context tree is
   * unconfigured. Returns the integration result so the caller can decide
   * whether to pin the CLI-version drift marker (don't pin on failure or the
   * next start skips the retry).
   */
  function ensureFirstTreeBinding(workspace: string, sessionCtx: SessionContext): boolean {
    if (!contextTreePath) return true;
    return installFirstTreeIntegration({
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
    // Race-window detector: every `ensureCodexBootstrap` call rewrites
    // AGENTS.md (per-chat block always changes). The detector logs when
    // two writes for the same workspace land inside the race window — see
    // proposal §⓪.3. Fix lives upstream (per-turn prompt API); we surface
    // the operational signal so "wrong chat context surfaces in codex"
    // bugs can be triaged.
    detectAgentsMdConcurrentWrite(workspace, Date.now(), (m) => sessionCtx.log(m));

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

    // CLI-version drift forces a fresh `installFirstTreeIntegration` so the
    // shipped `.agents/skills/*` payload tracks `first-tree upgrade` even
    // when the Context Tree HEAD is unchanged. Same "fail open" rule as
    // tree drift: a null on either side means "unknown" and we do not
    // force re-bootstrap.
    const currentCliVersion = resolveBundledCliVersion();
    const cachedCliVersion = readCachedBundledCliVersion(workspace);
    const cliDrifted =
      currentCliVersion !== null && cachedCliVersion !== null && currentCliVersion !== cachedCliVersion;

    if (sentinelPresent && !treeDrifted && !cliDrifted) {
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
    if (sentinelPresent && cliDrifted) {
      sessionCtx.log(
        `Bundled CLI version changed (${cachedCliVersion} → ${currentCliVersion}); re-running bootstrap to refresh skills`,
      );
    }

    bootstrapWorkspace({
      workspacePath: workspace,
      identity: sessionCtx.agent,
      contextTreePath,
      serverUrl: sessionCtx.sdk.serverUrl,
      briefing: { format: "agents-md", content: briefing },
    });
    // Core skills ship with every agent, with or without a Context Tree.
    // The core skill set is currently empty, so this is effectively a no-op;
    // the wiring stays so re-introducing one needs no handler change.
    installCoreSkills({
      workspacePath: workspace,
      log: (msg) => sessionCtx.log(msg),
    });
    const integrationOk = ensureFirstTreeBinding(workspace, sessionCtx);
    writeContextTreeHead(workspace, currentTreeHead);
    // Only pin the CLI version when integrate actually succeeded — pinning
    // on a failed run would silently mask the gap and the next start would
    // skip the retry that this drift trigger exists to perform.
    if (integrationOk) {
      writeBundledCliVersion(workspace, currentCliVersion);
    }
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
          reasoningEffort: "high",
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
      currentModel = payload.model || "";
      // Brand-new thread: the first `turn.completed` cumulative IS turn 1, so
      // the per-turn delta can use a zero baseline. (A cold `resume` leaves
      // these unset, so its first reading — a thread-wide cumulative — is
      // skipped rather than emitted as one giant turn.)
      prevCumulativeUsage = null;
      threadIsFresh = true;

      const input = await toCodexInput(message, sessionCtx);
      await runTurn(input, sessionCtx, 1);

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
          reasoningEffort: "high",
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
      currentModel = payload.model || "";

      if (message) {
        const input = await toCodexInput(message, sessionCtx);
        await runTurn(input, sessionCtx, 1);
      }
      return sessionId;
    },

    inject(message) {
      // Fire-and-forget — Codex turns are run-to-completion, so the message
      // is buffered and drained on the next available turn. Queue every
      // inject instead of only mid-turn injects so the async gap before
      // `runTurn()` sets `currentTurnPromise` cannot start parallel turns
      // and desynchronise the in-flight entry FIFO.
      if (!ctx) return;
      queuedMessages.push(message);
      scheduleQueuedMessagesDrain();
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
