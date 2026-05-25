import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AgentRuntimeConfigPayload,
  GitRepo,
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@first-tree/shared";
import { deriveRepoLocalPath } from "@first-tree/shared";
import { hasPendingForChat, tryResolveQuestionAnswer } from "../handlers/ask-user-bridge.js";
import type { pino } from "../observability/logger.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentConfigCache } from "./agent-config-cache.js";
import { buildAgentEnv, createParticipantCache, formatInboundContent, resolveSenderLabel } from "./agent-io.js";
import type { SessionConfig } from "./config.js";
import { Deduplicator } from "./deduplicator.js";
import type {
  AgentHandler,
  AgentIdentity,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "./handler.js";
import { createResultSink, type Trigger } from "./result-sink.js";
import { SessionRegistry } from "./session-registry.js";

type SessionEntry = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  status: SessionState;
  lastActivity: number;
  /** In-flight suspend promise; awaited before resume to avoid race conditions. */
  suspending: Promise<void> | null;
};

type PendingMessage = {
  message: SessionMessage;
  chatId: string;
  entryId: number;
};

/**
 * Resolve the directory the runtime reads markdown doc snapshots against —
 * the same dir the handler actually hands the agent as cwd for this chat.
 *
 * Two layouts coexist after the per-agent-home redesign (#506) and its
 * legacy-resume hotfix (#530):
 *  - NEW chats run cwd = the per-agent home (`<workspaceRoot>` itself, see
 *    `acquireAgentHome`), with predeclared source repos materialised at the
 *    TOP LEVEL (`<workspaceRoot>/<localPath>`). No `<workspaceRoot>/<chatId>/`
 *    dir is ever created.
 *  - LEGACY chats (created before #506) keep their original per-chat cwd
 *    `<workspaceRoot>/<chatId>/`, with their own v1.x layout (source repos at
 *    `<workspaceRoot>/<chatId>/<localPath>`); #530 resumes them in place.
 *
 * The doc base MUST agree with whichever cwd the handler chose, or the
 * snapshot scanner realpaths a non-existent root and embeds ZERO snapshots —
 * so every `.md` mention stays plain text instead of rendering a clickable
 * preview (the symptom this fixes for new chats). We discriminate by the same
 * cheap signal #530's claude-code `resume()` uses first: does the legacy
 * per-chat dir physically exist? Present ⇒ legacy layout; absent ⇒ per-agent
 * home.
 *
 * Pure read-only `existsSync` — no `acquireWorkspace`/`acquireAgentHome`,
 * whose mkdir side effects must not run on every outbound message.
 *
 * IMPORTANT — `existsSync(legacyDir)` is a *proxy* for "the handler chose the
 * legacy cwd". It is exact for new chats (no legacy dir ⇒ agent home, for both
 * handlers) but `SessionManager` is handler-agnostic (it only knows
 * `workspaceRoot`, never the handler kind), so two legacy-chat cases diverge —
 * the resolver returns the legacy dir while the handler actually ran at the
 * agent home:
 *   1. CODEX legacy chats. The codex handler has NO legacy-cwd branch:
 *      `start()` and `resume()` both use `acquireAgentHome` (see
 *      `handlers/codex.ts`; #530 left codex alone because its transcripts are
 *      not cwd-keyed). Pre-#506 codex still created `<workspaceRoot>/<chatId>/`,
 *      and those dirs persist (`cleanWorkspaces` is a no-op), so every legacy
 *      codex chat hits this divergence.
 *   2. A claude-code legacy chat whose SDK transcript was lost resumes COLD at
 *      the agent home (#530 case 3) while its `<chatId>/` dir still exists.
 * In both, a freshly-written doc at the agent home may snapshot a STALE copy
 * from the legacy dir, or stay plain text if it exists only at the home.
 *
 * This is NOT a regression: the prior code used `join(workspaceRoot, chatId)`
 * unconditionally, so legacy chats already resolved to the legacy dir — this
 * fix changes only the new-chat (no-legacy-dir) path. The divergence is
 * graceful (older revision, never an empty/wrong file), bounded to legacy chats
 * (which shrink over time), and the clean fix is to thread the handler's
 * resolved cwd through to the sink instead of re-probing here.
 */
export function resolveSessionDocRoot(workspaceRoot: string, chatId: string): string {
  const legacyPerChatRoot = join(workspaceRoot, chatId);
  return existsSync(legacyPerChatRoot) ? legacyPerChatRoot : workspaceRoot;
}

/**
 * Resolve the base path the runtime reads markdown doc snapshots against,
 * given the session doc root from {@link resolveSessionDocRoot}.
 *
 * NEVER returns null — every chat has a workspace, and the snapshot scanner
 * existence-checks each candidate inside the returned root, so a bare mention
 * that doesn't physically exist simply stays plain text rather than
 * mis-resolving. Previously this returned null for zero/multi-repo
 * workspaces, which left those messages with no `documentContext` at all, so
 * a doc the agent wrote in the workspace could never be previewed.
 *
 * Resolution:
 *  - exactly one repo → that repo's worktree, the unambiguous markdown-link
 *    root. The worktree is materialised at `<sessionRoot>/<localPath>`, so the
 *    base MUST be that ABSOLUTE path. Returning a bare relative `localPath`
 *    (the old behaviour) made the runtime resolve it against its own
 *    `process.cwd()` — the launch dir, not the session workspace — so it
 *    silently failed to find any doc and cloud preview was dead.
 *  - zero or multiple repos → the session doc root.
 */
export function documentBasePathFromRuntimeConfig(payload: AgentRuntimeConfigPayload, sessionRoot: string): string {
  if (payload.gitRepos.length === 1) {
    const repo = payload.gitRepos[0];
    const localPath = repo ? repoLocalPath(repo).trim() : "";
    if (localPath.length > 0) return join(sessionRoot, localPath);
  }
  return sessionRoot;
}

function repoLocalPath(repo: GitRepo): string {
  return repo.localPath ?? deriveRepoLocalPath(repo.url);
}

type SessionManagerConfig = {
  session: SessionConfig;
  concurrency: number;
  handlerFactory: HandlerFactory;
  handlerConfig: HandlerConfig;
  agentIdentity: AgentIdentity;
  sdk: FirstTreeHubSDK;
  log: pino.Logger;
  registryPath?: string;
  /** Step 4: optional config cache for refresh-before-dispatch on configVersion bump. */
  agentConfigCache?: AgentConfigCache;
  /**
   * Ack channel used by `dispatch` when an entry transitions out of `delivered`.
   * Wired to `clientConnection.sendInboxAck` so the entry is acked over the
   * same socket that delivered it.
   */
  ackEntry: (entryId: number) => Promise<void>;
  /** Callback when a session state changes (per-session granularity). */
  onStateChange?: (chatId: string, state: SessionState) => void;
  /** Callback when aggregated runtime state changes. */
  onRuntimeStateChange?: (state: RuntimeState) => void;
  /** Callback when a session emits a structured event (tool_call / error). */
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
};

/**
 * Manages per-chat session entries with session-oriented handler lifecycle.
 *
 * Key design:
 * - Delayed ACK: messages are ACKed when handler starts processing
 * - Three session states: active / suspended / evicted
 * - Streaming input injection for active sessions
 * - Concurrency limit on simultaneously active sessions
 * - Registry persistence for crash recovery
 */
/** Maximum number of evicted session mappings to retain for resume recovery. */
const MAX_EVICTED_MAPPINGS = 500;

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly evictedMappings = new Map<string, { claudeSessionId: string; lastActivity: number }>();
  private readonly config: SessionManagerConfig;
  private readonly deduplicator = new Deduplicator(1000);
  /**
   * Current trigger (messageId + senderId) per chat — the message that kicked
   * off the current or most-recent turn. Read by `forwardResult` (via the
   * resultSink closure) to attach `inReplyTo` and default mentions to the
   * outbound reply. Maintained entirely by the runtime: handlers never touch
   * this map, which keeps adding a new handler trivial.
   */
  private readonly currentTrigger = new Map<string, Trigger>();
  private readonly registry: SessionRegistry | null;
  private readonly pendingQueue: PendingMessage[] = [];
  private readonly lastReportedStates = new Map<string, SessionState>();
  private readonly sessionRuntimeStates = new Map<string, RuntimeState>();
  private lastReportedRuntimeState: RuntimeState | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private _activeCount = 0;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.registry = config.registryPath ? new SessionRegistry(config.registryPath) : null;
    this.idleTimer = setInterval(() => this.evictIdle(), 10_000);

    // Load persisted sessions (all start as suspended)
    this.loadPersistedSessions();
  }

  /**
   * Dispatch an inbox entry. ACK is deferred until handler starts processing.
   *
   * Delayed ACK: messages are ACKed when the handler begins processing,
   * not on pull. `delivered` = pulled but not yet processing,
   * `acked` = handler has started processing (read receipt).
   *
   * No routing guards run client-side any more: the cross-chat
   * reply-routing mechanism (`replyToChat` / `shouldSuppressEcho`) has been
   * removed (see first-tree-context PR #281), and the mention filter moved
   * server-side to fan-out (`services/message.ts sendMessage`). Anything
   * reaching dispatch is, by construction, meant for this agent.
   */
  async dispatch(entry: InboxEntryWithMessage): Promise<void> {
    const chatId = entry.chatId ?? entry.message.chatId;
    const messageId = entry.message.id;

    // 0. AskUserQuestion bridge: a `question_answer` message has two
    //    delivery paths:
    //
    //    a) Live waiter — the original `canUseTool` Promise is still
    //       pending in the bridge. Resolve it, ack the inbox entry, and
    //       short-circuit; the SDK takes the answer back into the same
    //       turn. This is the happy path while the agent's SDK process
    //       is still alive.
    //
    //    b) Stale waiter — the SDK process was killed (idle suspend or
    //       explicit shutdown) before the user answered. The bridge map
    //       was cleared by the handler at suspend time, so
    //       `tryResolveQuestionAnswer` reports no match. We must NOT
    //       short-circuit here: the answer needs to flow into the regular
    //       dispatch path so the handler resumes the session and feeds
    //       the answer to the SDK as fresh user input. The handler's
    //       formatInboundContent renders question_answer messages as
    //       readable text ("User selected: ..."), so the resumed turn
    //       sees a normal text prompt.
    if (entry.message.format === "question_answer") {
      const resolved = tryResolveQuestionAnswer(entry.message.content);
      if (resolved) {
        await this.ackEntry(entry.id, chatId);
        return;
      }
      this.config.log.info(
        { chatId, messageId },
        "question_answer with no live bridge waiter — resuming session with answer as input",
      );
      // Fall through to normal dispatch.
    }

    // 1. Deduplication — key by (chatId, messageId). Cross-chat reply
    // routing has been removed (see first-tree-context PR #281) so a single
    // message now produces exactly one inbox entry per recipient, but the
    // server-side identity is still (inboxId, messageId, chatId) and we
    // mirror it defensively in case a legacy entry surfaces or fan-out is
    // ever extended again.
    const dedupKey = `${chatId}:${messageId}`;
    if (this.deduplicator.isDuplicate(dedupKey)) {
      this.config.log.debug({ chatId, messageId }, "duplicate message, skipping");
      return;
    }

    // 2. Step 4: refresh runtime config if the message brought a newer
    // version. This is the *only* trigger for active-session re-config —
    // matches PRD §7.2. Failures are logged but do not block delivery on
    // M1: handler integration in Step 6 will decide whether to use the
    // stale config or hold the message until Hub recovers.
    if (this.config.agentConfigCache) {
      try {
        await this.config.agentConfigCache.refreshIfNewer(
          this.config.agentIdentity.agentId,
          entry.message.configVersion,
        );
      } catch (err) {
        this.config.log.warn(
          {
            chatId,
            agentId: this.config.agentIdentity.agentId,
            incomingVersion: entry.message.configVersion,
            err,
          },
          "config version mismatch — skipping refresh",
        );
      }
    }

    // Note: the "mention_only" filter now lives on the server (see
    // services/message.ts sendMessage fan-out). If an entry reaches dispatch
    // we assume server already decided we should handle it — this avoids a
    // double-guard that drifted between server / client in early M1.

    // 4. Extract message content (handler does not see inbox metadata)
    const message = this.extractMessage(entry);

    // 5. Route by session state — ACK happens inside route when handler starts
    await this.routeMessage(chatId, message, entry.id);
  }

  /** Handle a server-issued session command. Terminate drops all local state without reporting back. */
  async handleCommand(chatId: string, command: "session:suspend" | "session:terminate"): Promise<void> {
    if (command === "session:suspend") {
      const session = this.sessions.get(chatId);
      if (session?.status === "active") {
        this.config.log.info({ chatId }, "suspend command received");
        this.suspendSession(session);
      }
      return;
    }

    if (command === "session:terminate") {
      const session = this.sessions.get(chatId);
      const hadMapping = this.evictedMappings.has(chatId);
      if (!session && !hadMapping) return;

      this.config.log.info({ chatId }, "terminate command received");
      if (session?.status === "active") {
        this._activeCount--;
        await session.handler.shutdown().catch(() => {});
      }

      this.sessions.delete(chatId);
      this.evictedMappings.delete(chatId);
      this.sessionRuntimeStates.delete(chatId);
      this.lastReportedStates.delete(chatId);
      this.currentTrigger.delete(chatId);

      for (let i = this.pendingQueue.length - 1; i >= 0; i--) {
        if (this.pendingQueue[i]?.chatId === chatId) this.pendingQueue.splice(i, 1);
      }

      this.recomputeRuntimeState();
      this.persistRegistry();
      this.drainPendingQueue();
    }
  }

  /** Chat IDs this client still holds locally (sessions + evictedMappings). */
  getHeldChatIds(): string[] {
    const ids = new Set<string>();
    for (const id of this.sessions.keys()) ids.add(id);
    for (const id of this.evictedMappings.keys()) ids.add(id);
    return [...ids];
  }

  /**
   * Apply a server-declared stale list from `session:reconcile:result` — treat
   * each chatId as if a `session:terminate` command had arrived.
   */
  applyStaleChatIds(staleChatIds: string[]): void {
    for (const id of staleChatIds) {
      void this.handleCommand(id, "session:terminate");
    }
  }

  /** Shut down all sessions gracefully. */
  async shutdown(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }

    const shutdowns = [...this.sessions.values()].map((s) =>
      s.status === "active" ? s.handler.shutdown() : Promise.resolve(),
    );
    await Promise.allSettled(shutdowns);

    // Report active sessions as suspended before clearing
    for (const [chatId, session] of this.sessions) {
      if (session.status === "active") {
        this.notifySessionState(chatId, "suspended");
      }
    }

    // Persist final state
    this.persistRegistry();
    this.registry?.dispose();

    this.sessions.clear();
    this.evictedMappings.clear();
    this.lastReportedStates.clear();
    this.sessionRuntimeStates.clear();
    this.lastReportedRuntimeState = null;
    this._activeCount = 0;
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get totalCount(): number {
    return this.sessions.size;
  }

  /**
   * Snapshot used by the UpdateManager's quiet gate to decide whether it is
   * safe to exit the process for a self-update. `activeCount` is the number of
   * sessions currently handling a message; `lastActivityMs` is the most recent
   * activity timestamp across all tracked sessions (0 when there are none).
   */
  getQuietGateSnapshot(): { activeCount: number; lastActivityMs: number } {
    let lastActivityMs = 0;
    for (const entry of this.sessions.values()) {
      if (entry.lastActivity > lastActivityMs) lastActivityMs = entry.lastActivity;
    }
    return { activeCount: this._activeCount, lastActivityMs };
  }

  /** Return the current aggregate runtime state, or null if no sessions have reported. */
  getAggregateRuntimeState(): RuntimeState | null {
    return this.lastReportedRuntimeState;
  }

  /** Return all current session states for full state sync after reconnect. */
  getSessionStates(): Array<{ chatId: string; state: SessionState }> {
    return [...this.sessions.entries()].map(([chatId, entry]) => ({
      chatId,
      state: entry.status,
    }));
  }

  /**
   * ChatIds the client still holds in `evictedMappings` — i.e. either
   * hydrated from disk on startup or dropped from `sessions` by LRU. Used
   * by the agent-slot full-state-sync to advertise these as "suspended" on
   * the wire, so the server's `agent_chat_sessions.state` doesn't get
   * stuck on a pre-restart "active" snapshot when the in-memory handler is
   * actually gone.
   */
  getEvictedChatIds(): string[] {
    return [...this.evictedMappings.keys()];
  }

  // ---- Internal -----------------------------------------------------------

  private async routeMessage(chatId: string, message: SessionMessage, entryId?: number): Promise<void> {
    // Record the trigger BEFORE dispatching to any handler path (start /
    // resume / inject) so the resultSink constructed in buildSessionContext
    // sees the right messageId+senderId when this turn eventually produces a
    // reply. The sink clears it on forward so an intervening inject() can
    // overwrite it without the in-flight reply stealing the new trigger.
    if (message.id) {
      this.currentTrigger.set(chatId, { messageId: message.id, senderId: message.senderId });
    }

    const existing = this.sessions.get(chatId);

    if (existing) {
      switch (existing.status) {
        case "active":
          // ACK before injecting — handler is already processing
          await this.ackEntry(entryId, chatId);
          existing.handler.inject(message);
          existing.lastActivity = Date.now();
          // Re-arm the working-grace guard in `evictIdle`. Without this, a
          // turn that ends with `setRuntimeState("idle")` (claude-code.ts on
          // every result message) leaves the next inject-triggered turn
          // observable as `idle` — and a long-thinking turn that produces
          // no SDK messages for `idle_timeout` (300s default) trips
          // evictIdle's suspend path even though the agent is actively
          // working. Setting `working` here puts the session under the
          // `idle_timeout + working_grace_seconds` umbrella until the next
          // result flips it back.
          this.setSessionRuntimeState(chatId, "working");
          this.config.log.debug({ chatId }, "message injected");
          return;

        case "suspended":
        case "evicted":
          // Resume session — ACK happens inside resumeSession
          await this.resumeSession(existing, message, entryId);
          return;
      }
    }

    // No existing session — create new
    await this.startNewSession(chatId, message, entryId);
  }

  private async startNewSession(chatId: string, message: SessionMessage, entryId?: number): Promise<void> {
    // Enforce concurrency limit
    if (!this.acquireActiveSlot(chatId, message, entryId)) return;

    // ACK now — handler is about to start processing
    await this.ackEntry(entryId, chatId);

    // Enforce max_sessions (evict LRU)
    this.evictIfNeeded();

    // Check for prior evicted session mapping
    const evicted = this.evictedMappings.get(chatId);

    // Step 6: thread the AgentConfigCache to the handler so it can read the
    // current per-agent runtime config when launching its sub-process.
    const handlerCfg = this.config.agentConfigCache
      ? { ...this.config.handlerConfig, agentConfigCache: this.config.agentConfigCache }
      : this.config.handlerConfig;
    const handler = this.config.handlerFactory(handlerCfg);
    const ctx = this.buildSessionContext(chatId);

    const entry: SessionEntry = {
      chatId,
      claudeSessionId: evicted?.claudeSessionId ?? "",
      handler,
      status: "active",
      lastActivity: Date.now(),
      suspending: null,
    };

    this.sessions.set(chatId, entry);
    this._activeCount++;
    if (evicted) this.evictedMappings.delete(chatId);

    try {
      if (evicted) {
        const sessionId = await handler.resume(message, evicted.claudeSessionId, ctx);
        entry.claudeSessionId = sessionId;
        this.config.log.info({ chatId, sessionId }, "session resumed from eviction");
      } else {
        const sessionId = await handler.start(message, ctx);
        entry.claudeSessionId = sessionId;
        this.config.log.info({ chatId, sessionId }, "session created");
      }
      this.persistRegistry();
      this.notifySessionState(chatId, "active");
    } catch (err) {
      // Pre-fix this catch only logged and torn local state down. The
      // server's `agent_chat_sessions.state` stayed `active`, no chat
      // message was emitted, and the agent looked silently failed to
      // every observer. F2 (chat-participant-mode-fix-design.md §3.3)
      // signals the failure three ways: structured log (existing),
      // `session:state=errored` to the server (so admin/UI see it), and
      // a single user-visible chat message via the result-sink (so the
      // requester knows the agent didn't drop their message on purpose).
      const errMsg = err instanceof Error ? err.message : String(err);
      const phase: "start" | "resume" = evicted ? "resume" : "start";
      this.config.log.error({ chatId, err, phase }, "session start/resume failed");

      // 1) Server-side state. notifySessionState dedupes against the last
      //    reported value, so even if we somehow already reported "active"
      //    for this chat, this `errored` transition will go through.
      this.notifySessionState(chatId, "errored");

      // 2) User-visible chat message. Truncate to 800 chars so we don't
      //    leak full stderr (which may include FS paths or git internals)
      //    into the chat timeline; the full error is in the structured log.
      try {
        const preview = errMsg.slice(0, 800);
        const agentLabel = this.config.agentIdentity.displayName ?? this.config.agentIdentity.agentId;
        const userMsg = `⚠️ Session ${phase} failed (${agentLabel}): ${preview}`;
        await ctx.forwardResult(userMsg);
      } catch (forwardErr) {
        this.config.log.warn({ chatId, forwardErr }, "session error forward failed");
      }

      // 3) Existing local cleanup. Forward first, tear down second —
      //    keeps the order obviously safe regardless of future cleanup-
      //    block refactors. The follow-up message routes as a fresh
      //    start once the entry is gone.
      this.sessions.delete(chatId);
      this.sessionRuntimeStates.delete(chatId);
      this.recomputeRuntimeState();
      this._activeCount--;
    }
  }

  private async resumeSession(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    entryId?: number,
  ): Promise<void> {
    // Wait for in-flight suspension to complete before resuming
    if (entry.suspending) {
      await entry.suspending;
    }

    // For admin-triggered resume (no message), synthesize a minimal stub for slot acquisition only
    const slotMessage: SessionMessage = message ?? {
      id: "",
      chatId: entry.chatId,
      senderId: "",
      format: "text",
      content: "",
      metadata: {},
    };

    // Enforce concurrency limit
    if (!this.acquireActiveSlot(entry.chatId, slotMessage, entryId)) return;

    // ACK now — handler is about to resume processing
    await this.ackEntry(entryId, entry.chatId);

    const ctx = this.buildSessionContext(entry.chatId);
    entry.status = "active";
    this._activeCount++;
    entry.lastActivity = Date.now();

    try {
      // Mirror the pattern in `startNewSession` (line 449): the handler may
      // return a DIFFERENT sessionId than the one passed in — e.g. when the
      // claude-code handler detects a stale SDK transcript and falls
      // through to fresh-start semantics — and `entry.claudeSessionId` has
      // to track the handler's truth or future resume cycles will keep
      // calling the stale id. PR #530 nit baixiaohang flagged: without the
      // assignment back, a fresh-start fallback would persist the OLD id,
      // and the next suspend→resume cycle would re-trigger the same
      // missing-transcript fallback ad infinitum.
      const resumedSessionId = await entry.handler.resume(message ?? undefined, entry.claudeSessionId, ctx);
      entry.claudeSessionId = resumedSessionId;
      this.config.log.info({ chatId: entry.chatId, sessionId: entry.claudeSessionId }, "session resumed");
      this.persistRegistry();
      this.notifySessionState(entry.chatId, "active");
    } catch (err) {
      // Mirror `startNewSession`'s F2 contract (design §3.3): a resume that
      // throws is not the same shape as a suspend (the entry is unusable,
      // not just idle), so leaving `status = "suspended"` would lie to the
      // server and let the broken entry persist locally. Notify `errored`,
      // forward a chat-visible error, then drop the entry so the next
      // inbound message routes through `startNewSession` for a clean restart.
      const errMsg = err instanceof Error ? err.message : String(err);
      this.config.log.error({ chatId: entry.chatId, err }, "resume failed");

      this.notifySessionState(entry.chatId, "errored");

      try {
        const preview = errMsg.slice(0, 800);
        const agentLabel = this.config.agentIdentity.displayName ?? this.config.agentIdentity.agentId;
        const userMsg = `⚠️ Session resume failed (${agentLabel}): ${preview}`;
        await ctx.forwardResult(userMsg);
      } catch (forwardErr) {
        this.config.log.warn({ chatId: entry.chatId, forwardErr }, "session error forward failed");
      }

      this.sessions.delete(entry.chatId);
      this.sessionRuntimeStates.delete(entry.chatId);
      this.recomputeRuntimeState();
      this._activeCount--;
    }
  }

  /**
   * Try to acquire an active slot. If at concurrency limit:
   * 1. Suspend the least-recently-active session to free a slot
   * 2. If no candidates, queue the message
   *
   * Returns true if slot acquired, false if queued.
   */
  private acquireActiveSlot(chatId: string, message: SessionMessage, entryId?: number): boolean {
    if (this._activeCount < this.config.concurrency) return true;

    // Find least-recently-active session (excluding the target chat)
    let oldestActive: SessionEntry | null = null;
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      if (session.chatId === chatId) continue;
      if (!oldestActive || session.lastActivity < oldestActive.lastActivity) {
        oldestActive = session;
      }
    }

    if (oldestActive) {
      this.config.log.info({ chatId: oldestActive.chatId }, "session preempted for concurrency");
      this.suspendSession(oldestActive);
      return true;
    }

    // All active sessions are busy — queue (no ACK yet — message stays as delivered)
    this.config.log.info({ chatId }, "concurrency limit reached, queuing");
    this.pendingQueue.push({ message, chatId, entryId: entryId ?? -1 });
    return false;
  }

  private suspendSession(entry: SessionEntry): void {
    entry.status = "suspended";
    this._activeCount--;
    // Clear per-session runtime state on suspend
    this.sessionRuntimeStates.delete(entry.chatId);
    this.recomputeRuntimeState();
    entry.suspending = entry.handler
      .suspend()
      .catch((err) => {
        this.config.log.warn({ chatId: entry.chatId, err }, "suspend error");
      })
      .finally(() => {
        entry.suspending = null;
      });
    this.persistRegistry();
    this.notifySessionState(entry.chatId, "suspended");

    // Drain pending queue
    this.drainPendingQueue();
  }

  private drainPendingQueue(): void {
    if (this.pendingQueue.length === 0) return;
    if (this._activeCount >= this.config.concurrency) return;

    const next = this.pendingQueue.shift();
    if (!next) return;
    // Route asynchronously — entryId is passed for delayed ACK
    this.routeMessage(next.chatId, next.message, next.entryId > 0 ? next.entryId : undefined).catch((err) => {
      this.config.log.warn({ chatId: next.chatId, err }, "pending drain error");
    });
  }

  private evictIfNeeded(): void {
    const { max_sessions } = this.config.session;
    if (this.sessions.size < max_sessions) return;

    // Single pass: find LRU session, preferring non-active over active
    let candidate: { key: string; session: SessionEntry } | null = null;
    for (const [key, session] of this.sessions) {
      if (!candidate) {
        candidate = { key, session };
        continue;
      }
      const preferNonActive = session.status !== "active" && candidate.session.status === "active";
      const sameCategory = (session.status === "active") === (candidate.session.status === "active");
      if (preferNonActive || (sameCategory && session.lastActivity < candidate.session.lastActivity)) {
        candidate = { key, session };
      }
    }

    if (candidate) {
      // Preserve mapping for future recovery
      this.addEvictedMapping(candidate.key, {
        claudeSessionId: candidate.session.claudeSessionId,
        lastActivity: candidate.session.lastActivity,
      });

      this.config.log.info({ chatId: candidate.key }, "session evicted (max_sessions reached)");
      if (candidate.session.status === "active") {
        this._activeCount--;
        candidate.session.handler.shutdown().catch(() => {});
      }
      // LRU eviction is local memory-management, not operator intent — do
      // NOT emit a wire state here. The chat now lives in `evictedMappings`
      // and the next `agent:bound` (initial bind or reconnect) will pick it
      // up via `getEvictedChatIds()` in `agent-slot.fullStateSync` and
      // advertise it as `suspended`, so the server's `agent_chat_sessions.state`
      // converges to "handler is gone" on the next sync without churn on
      // every eviction.
      this.sessions.delete(candidate.key);
      this.sessionRuntimeStates.delete(candidate.key);
      // Drop the trigger alongside the session — the next message routed to
      // this chat will set a fresh one. Leaving stale entries here would
      // only burn memory (wrong replies are not a risk since `routeMessage`
      // overwrites before the handler runs), but since `terminate` already
      // cleans the same maps we keep the two paths symmetric.
      this.currentTrigger.delete(candidate.key);
      this.recomputeRuntimeState();
      this.persistRegistry();
    }
  }

  /**
   * Reclaim slots whose sessions have gone quiet.
   *
   * Invariants this routine relies on:
   *   1. `lastActivity` is monotonic per session and is bumped by every
   *      inbound activity — `dispatch` (new chat / resume), `inject`
   *      (mid-turn message), and the handler's `touch()` on each SDK event.
   *   2. `runtimeState` reflects what the agent is currently doing as best
   *      the runtime can tell:
   *        - `working` — a turn is in flight. Set by the handler at the top
   *          of its consume loop AND by `SessionManager` on every `inject`
   *          (because the handler can't observe inject from inside the SDK
   *          for-await — see #536). Cleared back to `idle` on each
   *          `result` message from the SDK.
   *        - `blocked` — only reachable if a handler chooses to set it
   *          explicitly. The runtime no longer auto-migrates `working` →
   *          `blocked` on inactivity: with reasoning models a 2-minute
   *          quiet stretch is normal deep-thinking, not a stuck process,
   *          and the auto-migration was producing false-positive UI
   *          warnings. State kept as a semantic slot for future use
   *          (e.g. if/when the SDK transport exposes a real stuck signal).
   *        - `idle` — no work in flight.
   *      If you add a new way to wake the session up, you MUST also set
   *      `runtimeState` to `working` from that path, or this guard will
   *      treat the chat as idle and reap it.
   *   3. `working_grace_seconds` is an UPPER bound on how long a `working`
   *      / `blocked` chat can hold a slot past `idle_timeout` — defends
   *      against a stuck handler that never flips back to `idle`.
   */
  private evictIdle(): void {
    const timeoutMs = this.config.session.idle_timeout * 1000;
    const workingGraceMs = this.config.session.working_grace_seconds * 1000;
    const now = Date.now();
    const agentId = this.config.agentIdentity.agentId;

    for (const [, session] of this.sessions) {
      if (session.status !== "active") continue;
      const inactiveMs = now - session.lastActivity;
      if (inactiveMs <= timeoutMs) continue;

      const currentState = this.sessionRuntimeStates.get(session.chatId);

      // Hard cap: regardless of `runtimeState`, once we are past
      // `idle_timeout + working_grace_seconds` the slot MUST be reclaimed.
      // Anything else means a stuck handler can hold a slot forever just
      // by never flipping `runtimeState` back to `idle`.
      const pastHardCap = inactiveMs >= timeoutMs + workingGraceMs;

      // #418: when an AskUserQuestion is in flight, suspending tears down
      // the SDK transport and silently drops the bridge entry — the
      // eventual answer then arrives with no live waiter and the asker
      // session is permanently stuck. Skip the suspend so the awaiter can
      // resolve through the live-bridge path. `lastActivity` still ticks
      // forward on inject, so a runaway pending entry is bounded by the
      // supersede paths (chat archive / client claim) and, as a last
      // resort, by the hard cap above.
      if (!pastHardCap && hasPendingForChat(agentId, session.chatId)) {
        this.config.log.info(
          { chatId: session.chatId, inactiveSec: Math.round(inactiveMs / 1000) },
          "session idle but AskUserQuestion in flight — skipping suspend",
        );
        continue;
      }

      // `lastActivity` is bumped per inbound SDK message/event (handler
      // `touch()`), so a long thinking turn or a single very large message
      // looks identical to "session has been idle" here. Without this
      // exemption the runtime suspends the SDK transport mid-thinking and
      // the work is lost. The hard cap above bounds the worst case.
      const stillProgressing = currentState === "working" || currentState === "blocked";
      if (stillProgressing && !pastHardCap) {
        this.config.log.info(
          {
            chatId: session.chatId,
            runtimeState: currentState,
            inactiveSec: Math.round(inactiveMs / 1000),
            graceSec: this.config.session.working_grace_seconds,
          },
          "session idle threshold reached but still working — skipping suspend",
        );
        continue;
      }

      this.config.log.info(
        {
          chatId: session.chatId,
          idleTimeoutSec: this.config.session.idle_timeout,
          runtimeState: currentState ?? "idle",
          pastHardCap,
        },
        "session idle, suspending",
      );
      this.suspendSession(session);
    }
  }

  /** Add an evicted mapping, pruning the oldest if over capacity. */
  private addEvictedMapping(chatId: string, mapping: { claudeSessionId: string; lastActivity: number }): void {
    this.evictedMappings.set(chatId, mapping);
    if (this.evictedMappings.size > MAX_EVICTED_MAPPINGS) {
      // Map iteration order is insertion order — first key is the oldest
      const oldest = this.evictedMappings.keys().next().value;
      if (oldest !== undefined) this.evictedMappings.delete(oldest);
    }
  }

  /** Notify per-session state change to the server via callback. Deduplicates redundant reports. */
  private notifySessionState(chatId: string, state: SessionState): void {
    if (!this.config.onStateChange) return;
    if (this.lastReportedStates.get(chatId) === state) return;
    this.lastReportedStates.set(chatId, state);
    this.config.onStateChange(chatId, state);
  }

  /**
   * ACK an inbox entry — delayed until handler starts processing. Routes
   * through `config.ackEntry`, which is wired to the WS data plane.
   */
  private async ackEntry(entryId: number | undefined, chatId: string): Promise<void> {
    if (entryId === undefined) return;
    try {
      await this.config.ackEntry(entryId);
    } catch {
      this.config.log.warn({ chatId, entryId }, "ACK failed, continuing");
    }
  }

  private buildSessionContext(chatId: string): SessionContext {
    const sessionLog = this.config.log.child({ chatId });
    // Runtime-facing string log (handler + result-sink expect a simple
    // `(msg: string) => void` signature). The child pino logger still goes
    // to other places that want structured fields.
    const log = (msg: string) => sessionLog.info(msg);

    // One participant cache per session — consumed by formatInboundContent
    // (for resolving `[From: <name>]`). First use triggers a fetch; subsequent
    // calls hit memory. v1 §四 改造 4 removed result-sink's dependency on
    // this cache (the trigger-sender mention branch is gone), so the cache
    // now flows only into the inbound-formatter path.
    const participants = createParticipantCache(this.config.sdk, chatId, log);

    // Cross-agent doc preview: `workspaceRoot` is `<workspaces>/<agentSlug>`
    // (see agent-slot.ts), so the shared common root is its parent and this
    // agent's slug is its basename — derived from existing config, no new
    // config surface (decision: config-ascent).
    const workspacesRoot = dirname(this.config.handlerConfig.workspaceRoot);
    const selfSlug = basename(this.config.handlerConfig.workspaceRoot);
    // Resolve the doc base SYNCHRONOUSLY from the already-populated config
    // cache so it can ride the agent's env (`buildAgentEnv` is sync). This
    // lets a `first-tree chat send` sub-process snapshot referenced docs
    // exactly like result-sink does (L3: unify capture across send paths).
    // result-sink keeps its own async `getDocumentBasePath`; both read the
    // same cache (`refreshIfNewer(_, 0)` returns the cached payload), so the
    // base they compute agrees. Falls back to the session doc root when the
    // cache has no payload yet (== the single/zero-repo default).
    const sessionRoot = resolveSessionDocRoot(this.config.handlerConfig.workspaceRoot, chatId);
    const cachedPayload = this.config.agentConfigCache?.get(this.config.agentIdentity.agentId)?.payload;
    const docBase = cachedPayload ? documentBasePathFromRuntimeConfig(cachedPayload, sessionRoot) : sessionRoot;

    const forwardResult = createResultSink({
      sdk: this.config.sdk,
      agent: this.config.agentIdentity,
      chatId,
      getTrigger: () => this.currentTrigger.get(chatId) ?? null,
      clearTrigger: () => {
        this.currentTrigger.delete(chatId);
      },
      log,
      getDocumentBasePath: () => this.resolveDocumentBasePath(log, chatId),
      workspacesRoot,
      selfSlug,
    });

    const envCtx = {
      sdk: this.config.sdk,
      agent: this.config.agentIdentity,
      chatId,
      docContext: { base: docBase, workspacesRoot, selfSlug },
    };

    return {
      agent: this.config.agentIdentity,
      sdk: this.config.sdk,
      log,
      chatId,
      touch: () => {
        const entry = this.sessions.get(chatId);
        if (entry && entry.status === "active") {
          entry.lastActivity = Date.now();
        }
      },
      setRuntimeState: (state) => {
        this.setSessionRuntimeState(chatId, state);
      },
      emitEvent: (event) => {
        this.config.onSessionEvent?.(chatId, event);
      },
      forwardResult,
      buildAgentEnv: (parentEnv) => buildAgentEnv(parentEnv, envCtx),
      formatInboundContent: (message) => formatInboundContent(message, participants),
      resolveSenderLabel: async (senderId) => resolveSenderLabel(senderId, await participants.get()),
    };
  }

  private async resolveDocumentBasePath(log: (msg: string) => void, chatId: string): Promise<string> {
    // Session doc root: the dir the handler actually hands the agent as cwd —
    // the per-agent home for new chats, the legacy `<workspaceRoot>/<chatId>/`
    // dir for pre-#506 chats. See `resolveSessionDocRoot` (read-only existsSync;
    // no acquire* side effects on every outbound message).
    const sessionRoot = resolveSessionDocRoot(this.config.handlerConfig.workspaceRoot, chatId);
    if (!this.config.agentConfigCache) return sessionRoot;
    try {
      const { payload } = await this.config.agentConfigCache.refreshIfNewer(this.config.agentIdentity.agentId, 0);
      return documentBasePathFromRuntimeConfig(payload, sessionRoot);
    } catch (err) {
      log(
        `document preview base path: config unavailable, using session doc root: ${err instanceof Error ? err.message : String(err)}`,
      );
      return sessionRoot;
    }
  }

  /** Update per-session runtime state and recompute aggregate. Only active sessions may update. */
  private setSessionRuntimeState(chatId: string, state: RuntimeState): void {
    const session = this.sessions.get(chatId);
    if (!session || session.status !== "active") return;
    this.sessionRuntimeStates.set(chatId, state);
    this.recomputeRuntimeState();
  }

  /** Aggregate per-session runtime states: error > blocked > working > idle. */
  private recomputeRuntimeState(): void {
    if (!this.config.onRuntimeStateChange) return;

    let aggregate: RuntimeState = "idle";
    for (const state of this.sessionRuntimeStates.values()) {
      if (state === "error") {
        aggregate = "error";
        break;
      }
      if (state === "blocked") {
        aggregate = "blocked";
      } else if (state === "working" && aggregate !== "blocked") {
        aggregate = "working";
      }
    }

    if (aggregate !== this.lastReportedRuntimeState) {
      this.lastReportedRuntimeState = aggregate;
      this.config.onRuntimeStateChange(aggregate);
    }
  }

  private extractMessage(entry: InboxEntryWithMessage): SessionMessage {
    const msg = entry.message;
    return {
      id: msg.id,
      chatId: entry.chatId ?? msg.chatId,
      senderId: msg.senderId,
      format: msg.format,
      content: msg.content as string | Record<string, unknown>,
      metadata: msg.metadata,
      precedingMessages: msg.precedingMessages ?? [],
    };
  }

  private loadPersistedSessions(): void {
    if (!this.registry) return;

    const persisted = this.registry.load();
    for (const [chatId, data] of persisted) {
      // All persisted sessions become evicted mappings on load.
      // Handlers are allocated lazily when a message arrives (startNewSession
      // checks evictedMappings and calls handler.resume instead of start).
      this.addEvictedMapping(chatId, {
        claudeSessionId: data.claudeSessionId,
        lastActivity: data.lastActivity,
      });
    }

    if (persisted.size > 0) {
      this.config.log.info({ count: persisted.size }, "loaded persisted session mappings");
    }
  }

  private persistRegistry(): void {
    if (!this.registry) return;

    const entries = new Map<string, { claudeSessionId: string; lastActivity: number; status: string }>();
    for (const [chatId, session] of this.sessions) {
      entries.set(chatId, {
        claudeSessionId: session.claudeSessionId,
        lastActivity: session.lastActivity,
        status: session.status,
      });
    }
    // Include evicted mappings for crash recovery
    for (const [chatId, mapping] of this.evictedMappings) {
      entries.set(chatId, {
        claudeSessionId: mapping.claudeSessionId,
        lastActivity: mapping.lastActivity,
        status: "evicted",
      });
    }
    this.registry.save(entries);
  }
}
