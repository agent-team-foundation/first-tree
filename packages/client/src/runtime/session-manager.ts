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
import { deriveRepoLocalPath, isImageBatchRefContent, isImageRefContent } from "@first-tree/shared";
import type { pino } from "../observability/logger.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentConfigCache } from "./agent-config-cache.js";
import { buildAgentEnv, createParticipantCache, formatInboundContent, resolveSenderLabel } from "./agent-io.js";
import { type ContextTreeBinding, syncAgentContextTree } from "./bootstrap.js";
import type { SessionConfig } from "./config.js";
import { reresolveUnboundTree } from "./context-tree-rebind.js";
import type { SelfFence } from "./doc-snapshots.js";
import { type Classification, clampRetryAttempt, classify, ERROR_KINDS, nextRetryDelayMs } from "./error-taxonomy.js";
import type {
  AgentHandler,
  AgentIdentity,
  HandlerConfig,
  HandlerFactory,
  SessionContext,
  SessionMessage,
} from "./handler.js";
import { findImagePath, writeImage } from "./image-store.js";
import { InboxDeliveryCoordinator } from "./inbox-delivery-coordinator.js";
import { redactErrorPreview } from "./redact-error-preview.js";
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
  /**
   * Transient-retry bookkeeping (Bug 1 fix). When handler.start / handler.resume
   * throws a classified-transient error we schedule a retry instead of
   * deleting the entry. A pending timer is tracked here so an arriving user
   * message can trigger an immediate retry (cancelling the timer) and shutdown
   * can clear it.
   */
  retryAttempt: number;
  retryNextAt: number | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Last classified-transient failure, kept so a manually-triggered retry
   * (from an incoming user message) can re-use the same reasonCode for
   * structured logging.
   */
  lastRetryReason: string | null;
  /**
   * Truncated raw message from the last transient failure. Surfaced into the
   * `resilience.session.retry_started` event payload alongside `reasonCode`
   * so the web UI can show the underlying cause (especially for the
   * `unknown` / `git_unknown` reasonCodes where the reasonCode alone says
   * nothing actionable). Cleared on a successful start/resume.
   */
  lastRetryRawError: string | null;
  /** Original message used to bootstrap this session, replayed on retry. */
  startMessage: SessionMessage | null;
  /**
   * Messages that arrived while start/resume is in transient retry. They must
   * not replace `startMessage`: the older accepted inbox entry is still ahead
   * of them in the ACK prefix, so retry consumes the original trigger first and
   * injects these only after the handler is live again.
   */
  retryQueuedMessages: SessionMessage[];
  /**
   * When we entered transient-retry mode this is set to the evicted mapping
   * captured at startNewSession time. Lets a retry re-use the same resume
   * path (handler.resume) instead of regressing to handler.start.
   */
  retryFromEvicted: { claudeSessionId: string; lastActivity: number } | null;
};

type PendingMessage = {
  message: SessionMessage;
  chatId: string;
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
  const localPath = singleRepoLocalPathFromPayload(payload);
  return localPath ? join(sessionRoot, localPath) : sessionRoot;
}

/**
 * Extract the lone declared source-repo `localPath` for snapshot self-fence
 * promotion. Returns null when the agent has zero or multiple repos, or when
 * the single repo's localPath is blank — both cases bypass promotion so a
 * relative `docs/foo.md` resolves against the agent home directly.
 *
 * Centralised here (rather than reimplemented in {@link documentBasePathFromRuntimeConfig})
 * so the env-path / sessionRoot / SelfFence all derive from one source.
 */
export function singleRepoLocalPathFromPayload(payload: AgentRuntimeConfigPayload): string | null {
  if (payload.gitRepos.length !== 1) return null;
  const repo = payload.gitRepos[0];
  if (!repo) return null;
  const localPath = repoLocalPath(repo).trim();
  return localPath.length > 0 ? localPath : null;
}

/**
 * Build the {@link SelfFence} the snapshot pipeline gates absolute paths on.
 * `agentHome` is whatever `resolveSessionDocRoot` picked (per-agent home for
 * new chats, legacy per-chat dir for pre-#506 chats); the optional
 * `singleRepoLocalPath` enables relative-path promotion so the abs and rel
 * forms of a source-repo doc share a single snapshot key.
 *
 * Mirrors {@link documentBasePathFromRuntimeConfig} but exposes the agent home
 * itself, not the narrower source-repo top — so on-demand `worktrees/<task>/`
 * checkouts (PR #498's idiom) also resolve.
 */
export function selfFenceFromRuntimeConfig(payload: AgentRuntimeConfigPayload | null, sessionRoot: string): SelfFence {
  if (!payload) return { agentHome: sessionRoot };
  const singleRepoLocalPath = singleRepoLocalPathFromPayload(payload);
  return singleRepoLocalPath ? { agentHome: sessionRoot, singleRepoLocalPath } : { agentHome: sessionRoot };
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
  /**
   * Same-socket chat recovery: reset delivered-but-unacked entries for the
   * chat back to pending and redeliver them on this connection.
   */
  recoverChat?: (chatId: string) => Promise<void>;
  /**
   * Resolver for the agent's Context Tree binding, used to lazily upgrade a
   * tree-LESS slot to tree-bound at session start (new-tree onboarding sets the
   * org `context_tree` only after the slot starts). Defaults to a live
   * `syncAgentContextTree(sdk)`; injected as a stub in tests to avoid spawning
   * real git.
   */
  resolveContextTreeBinding?: () => Promise<ContextTreeBinding | null>;
  /** Callback when a session state changes (per-session granularity). */
  onStateChange?: (chatId: string, state: SessionState) => void;
  /** Callback when aggregated runtime state changes. */
  onRuntimeStateChange?: (state: RuntimeState) => void;
  /** Callback when a session emits a structured event (tool_call / error). */
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  /**
   * Callback when a session's per-(agent,chat) runtime state changes (the
   * D-axis: idle / working / blocked / error). Distinct from
   * `onRuntimeStateChange`, which reports the lossy agent-global aggregate;
   * this carries the chatId so the server can persist the D-axis at
   * per-chat granularity. Also fired on the periodic re-affirm for
   * working / blocked / error sessions so a long turn keeps the
   * server-side freshness stamp current.
   */
  onSessionRuntimeChange?: (chatId: string, state: RuntimeState) => void;
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

/**
 * Minimum spacing between lazy Context-Tree re-resolutions for a slot that is
 * currently tree-LESS. Caps the per-new-session git + HTTP probe for a
 * permanently-tree-less agent at once per minute, while still picking up a tree
 * configured later within this window. Tree-BOUND slots never reach this gate
 * (they exit on the cheap already-bound check).
 */
const TREE_RERESOLVE_INTERVAL_MS = 60_000;

/**
 * Base interval for re-affirming per-(agent,chat) runtime so the server-side
 * `runtime_state_at` stays inside its freshness window during a long turn.
 * Kept at 1/3 of the server's `RUNTIME_STALE_MS` (60 s) so a single dropped
 * frame doesn't let a live turn flap to idle — matches the approved spec
 * (proposals/hub-agent-status-working-freshness.20260525.md §6.1 §10). The
 * actual fire time is jittered ±20 % around this base to prevent
 * thundering-herd alignment across hundreds of clients restarting at once.
 */
const RUNTIME_REAFFIRM_BASE_MS = 20_000;
const RUNTIME_REAFFIRM_JITTER_RATIO = 0.2;

function jitteredReaffirmDelay(): number {
  const offset = (Math.random() * 2 - 1) * RUNTIME_REAFFIRM_BASE_MS * RUNTIME_REAFFIRM_JITTER_RATIO;
  return RUNTIME_REAFFIRM_BASE_MS + offset;
}

function buildEmptySessionMessage(chatId: string): SessionMessage {
  return { id: "", chatId, senderId: "", format: "text", content: "", metadata: {} };
}

function previousAvailable(entry: SessionEntry): boolean {
  return Boolean(entry.claudeSessionId) || Boolean(entry.retryFromEvicted?.claudeSessionId);
}

/**
 * Encode a resilience event into the closed `error` event payload by
 * prefixing the message with the event name. Future server-side consumers
 * detect the prefix and re-route; today's web UI just renders the JSON
 * payload as text — see client-resilience design §6.1 for the "kind: 'error'
 * + tagged message" bridge. Server-side `sessionEventSchema` stays untouched.
 */
export function encodeResilienceMessage(eventName: string, payload: Record<string, unknown>): string {
  return `${eventName}: ${JSON.stringify(payload)}`;
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly evictedMappings = new Map<string, { claudeSessionId: string; lastActivity: number }>();
  private readonly config: SessionManagerConfig;
  private readonly inboxDelivery: InboxDeliveryCoordinator;
  /** Last lazy Context-Tree re-resolution attempt (epoch ms); see `TREE_RERESOLVE_INTERVAL_MS`. */
  private lastTreeResolveAttemptAt = 0;
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
  private runtimeReaffirmTimer: ReturnType<typeof setTimeout> | null = null;
  private _activeCount = 0;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.inboxDelivery = new InboxDeliveryCoordinator({
      ackEntry: config.ackEntry,
      recoverChat: config.recoverChat,
      onWorkChanged: (chatId) => this.projectSessionRuntime(chatId),
      log: config.log,
    });
    this.registry = config.registryPath ? new SessionRegistry(config.registryPath) : null;
    this.idleTimer = setInterval(() => this.evictIdle(), 10_000);
    // Independent of `evictIdle` (which early-continues on freshly-active
    // sessions): re-affirm working / error sessions so the
    // server-side `runtime_state_at` stays inside the freshness window.
    // Jittered setTimeout (rearmed each tick) instead of setInterval so
    // many clients don't align on the same instant.
    if (config.onSessionRuntimeChange) {
      const armReaffirm = () => {
        this.runtimeReaffirmTimer = setTimeout(() => {
          this.reaffirmRuntimeStates();
          armReaffirm();
        }, jitteredReaffirmDelay());
      };
      armReaffirm();
    }

    // Load persisted sessions (all start as suspended)
    this.loadPersistedSessions();
  }

  /**
   * Dispatch an inbox entry. ACK is deferred until the handler reports a
   * completed turn via `ctx.finishTurn(...)`.
   *
   * Delayed ACK semantics (post inflight-message-recovery): the entry stays
   * `delivered` server-side until forwardResult succeeds (or the handler
   * surfaces a permanent error). If this client crashes mid-turn, the next
   * `agent:bind` resets the entry back to `pending` so a fresh client
   * resumes the work — see docs/inflight-message-recovery-design.md.
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

    if (
      this.inboxDelivery.shouldRecoverBeforeDispatch(
        chatId,
        this.hasHealthyLiveHandler(chatId) || this.hasPendingTransientRetry(chatId),
        this.hasLocalSessionRecord(chatId),
      )
    ) {
      await this.inboxDelivery.recoverIfNeeded(chatId, `before_dispatch:${entry.id}:${messageId}`);
      return;
    }

    const decision = this.inboxDelivery.receive(entry);
    if (decision.kind !== "deliver") return;
    const { work } = decision;

    let routePromise: Promise<void> | undefined;
    await this.inboxDelivery.runAdmission(work, async () => {
      if (!this.inboxDelivery.hasEntry(work)) return;

      // 2. Step 4: refresh runtime config if the message brought a newer
      // version. This is the *only* trigger for active-session re-config —
      // matches PRD §7.2. Failures are logged but do not block delivery on
      // M1: handler integration in Step 6 will decide whether to use the
      // stale config or hold the message until the server recovers.
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

      if (!this.inboxDelivery.hasEntry(work)) return;

      // Note: the "mention_only" filter now lives on the server (see
      // services/message.ts sendMessage fan-out). If an entry reaches dispatch
      // we assume server already decided we should handle it — this avoids a
      // double-guard that drifted between server / client in early M1.

      // 4. Extract message content (handler does not see inbox metadata)
      const message = this.extractMessage(entry);

      // 4b. Pull any referenced image bytes to local disk before the handler
      // renders. Bytes live in the server's `attachments` object store (uploaded
      // by the sender); each client fetches once and caches under the chat's
      // images dir. Best-effort — a failed fetch leaves the handler to surface a
      // "not available on this device" placeholder for that ref.
      await this.ensureImagesLocal(message);

      if (!this.inboxDelivery.markAccepted(work)) return;

      // 4c. Lazily resolve a tree-LESS Context Tree binding before routing this
      // message to a (possibly new) session. The binding is frozen at
      // `AgentSlot.start()`, but the new-tree onboarding flow sets the org
      // `context_tree` only afterwards — without this the fresh agent would
      // never pick up its tree until a daemon restart. Done INSIDE the
      // admission barrier so the `handlerConfig` patch lands before routing and
      // a same-chat follow-up can't race a half-resolved binding, and only when
      // no live session exists for this chat (a start / resume, never an inject
      // into an active turn). No-op + no network once bound.
      if (!this.hasHealthyLiveHandler(chatId)) {
        await this.ensureContextTreeBinding();
      }

      // 5. Route by session state. ACK no longer happens inside route — the
      // entry sits in the coordinator ledger until the handler completes the
      // concrete message/batch it actually consumed. Do not await inside the
      // admission barrier: for Codex/TUI, route promises can span the whole
      // turn, but same-chat later messages must still be able to append once
      // this entry has reached handler membership.
      routePromise = this.routeMessage(chatId, message).catch((err) => {
        if (this.inboxDelivery.hasEntry(work)) {
          this.inboxDelivery.retryTurn(chatId, message, "route_message_failed");
        }
        throw err;
      });
    });

    if (routePromise) await routePromise;
  }

  /**
   * Resolve every image reference on an inbound `format: "file"` message to a
   * file on local disk, fetching missing bytes from the `attachments` store.
   * Single-ref and batch-ref shapes are both handled; non-image file content
   * is ignored. Fetches run in parallel and never throw — the renderer
   * degrades to a placeholder for any ref that didn't land.
   */
  private async ensureImagesLocal(message: SessionMessage): Promise<void> {
    if (message.format !== "file") return;
    const refs = isImageBatchRefContent(message.content)
      ? message.content.attachments
      : isImageRefContent(message.content)
        ? [message.content]
        : [];
    if (refs.length === 0) return;

    await Promise.all(
      refs.map(async (ref) => {
        if (findImagePath(message.chatId, ref.imageId, ref.mimeType)) return;
        try {
          const { bytes } = await this.config.sdk.fetchAttachment({ id: ref.imageId });
          await writeImage({
            chatId: message.chatId,
            imageId: ref.imageId,
            mimeType: ref.mimeType,
            base64: bytes.toString("base64"),
          });
        } catch (err) {
          this.config.log.warn(
            { chatId: message.chatId, imageId: ref.imageId, err },
            "eager image fetch failed — message will render a placeholder",
          );
        }
      }),
    );
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
      if (session?.retryTimer) {
        clearTimeout(session.retryTimer);
        session.retryTimer = null;
      }
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

      // Terminate is operator intent: accepted delivery work can be drained,
      // but coordinator keeps any uncommitted tail as recovery debt.
      await this.inboxDelivery.drainForTerminate(chatId);

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
    if (this.runtimeReaffirmTimer) {
      clearTimeout(this.runtimeReaffirmTimer);
      this.runtimeReaffirmTimer = null;
    }

    // Cancel any pending transient-retry timers — shutdown must not leave
    // setTimeouts armed that fire after the manager is gone.
    for (const session of this.sessions.values()) {
      if (session.retryTimer) {
        clearTimeout(session.retryTimer);
        session.retryTimer = null;
      }
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

    // Persist final state — flush synchronously so the last batch reaches
    // disk before dispose() tears the timer down.
    this.persistRegistry({ immediate: true });
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

  /**
   * Compatibility hook for AgentSlot's bind listener. Bind-time recovery is
   * now server-driven; chat-scoped same-socket recovery is requested lazily
   * by `dispatch` when a locally held chat has no healthy live handler.
   */
  noteBindRecoveryComplete(): void {
    // Intentionally no-op.
  }

  // ---- Internal -----------------------------------------------------------

  private hasHealthyLiveHandler(chatId: string): boolean {
    const entry = this.sessions.get(chatId);
    return entry?.status === "active" && entry.suspending === null;
  }

  private hasPendingTransientRetry(chatId: string): boolean {
    const entry = this.sessions.get(chatId);
    return Boolean(entry && entry.retryAttempt > 0);
  }

  private hasLocalSessionRecord(chatId: string): boolean {
    return this.sessions.has(chatId) || this.evictedMappings.has(chatId);
  }

  private async routeMessage(chatId: string, message: SessionMessage): Promise<void> {
    const existing = this.sessions.get(chatId);

    // Transient retry path: keep the original start/resume message at the head
    // of the provider retry. Newer messages sit later in the inbox ACK prefix,
    // so they are queued and injected only after retry succeeds.
    if (existing && existing.retryAttempt > 0) {
      existing.retryQueuedMessages.push(message);
      this.triggerImmediateRetry(chatId);
      return;
    }

    if (existing) {
      switch (existing.status) {
        case "active":
          this.setCurrentTrigger(chatId, message);
          existing.handler.inject(message);
          existing.lastActivity = Date.now();
          this.projectSessionRuntime(chatId);
          this.config.log.debug({ chatId }, "message injected");
          return;

        case "suspended":
        case "evicted":
          await this.resumeSession(existing, message);
          return;
      }
    }

    // No existing session — create new
    await this.startNewSession(chatId, message);
  }

  /**
   * Lazily resolve the agent's Context Tree binding when its slot came up
   * tree-less. The binding is resolved once at `AgentSlot.start()` and frozen
   * into `handlerConfig`; the new-tree onboarding flow sets the org
   * `context_tree` only AFTER that, so a fresh agent would otherwise stay
   * unbound until a daemon restart. Re-resolving at each new session is cheap
   * once bound (`reresolveUnboundTree` short-circuits without a network call)
   * and patches `handlerConfig` in place — so the handler built in
   * `startNewSession`, and every later session on this slot, sees the tree,
   * installs the First Tree skills, and writes the W1 workspace manifest.
   */
  private async ensureContextTreeBinding(): Promise<void> {
    const cfg = this.config.handlerConfig;
    // Already bound — cheapest exit (no clock read, no resolver, no network).
    if (typeof cfg.contextTreePath === "string" && cfg.contextTreePath.length > 0) return;
    // Tree-less: rate-limit re-resolution so a permanently-tree-less agent (the
    // common case) doesn't spawn git + an HTTP GET on EVERY new session for the
    // slot's whole life. A tree configured later is still picked up within
    // TREE_RERESOLVE_INTERVAL_MS on the next new session.
    const now = Date.now();
    if (now - this.lastTreeResolveAttemptAt < TREE_RERESOLVE_INTERVAL_MS) return;
    this.lastTreeResolveAttemptAt = now;

    const resolve =
      this.config.resolveContextTreeBinding ??
      (() => syncAgentContextTree(this.config.sdk, (msg) => this.config.log.info(msg)));
    const binding = await reresolveUnboundTree(cfg.contextTreePath, resolve);
    if (!binding) return;
    cfg.contextTreePath = binding.path;
    cfg.contextTreeRepoUrl = binding.repoUrl;
    cfg.contextTreeBranch = binding.branch;
    this.config.log.info(
      { path: binding.path, repoUrl: binding.repoUrl },
      "context tree binding resolved lazily (agent was unbound at slot start)",
    );
  }

  private async startNewSession(chatId: string, message: SessionMessage): Promise<void> {
    // Enforce concurrency limit
    if (!this.acquireActiveSlot(chatId, message)) return;

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
      retryAttempt: 0,
      retryNextAt: null,
      retryTimer: null,
      lastRetryReason: null,
      lastRetryRawError: null,
      startMessage: message,
      retryQueuedMessages: [],
      retryFromEvicted: evicted ?? null,
    };

    this.sessions.set(chatId, entry);
    this._activeCount++;
    if (evicted) this.evictedMappings.delete(chatId);

    // Report `active` before runtime projection. `session:runtime` frames are
    // active-gated on the server, so the state row must exist before a fresh
    // delivery projects this chat to working.
    this.notifySessionState(chatId, "active");
    this.projectSessionRuntime(chatId);
    try {
      this.setCurrentTrigger(chatId, message);
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
    } catch (err) {
      const phase: "start" | "resume" = evicted ? "resume" : "start";
      const classification = classify(err, { source: "session" });
      const handled = this.handleSessionFailure({
        entry,
        ctx,
        err,
        phase,
        classification,
      });
      if (!handled) {
        // Permanent / degraded failure: tear down (legacy F2 path) and ack
        // every in-flight entry so the server doesn't redeliver a message
        // that would just re-hit the same permanent failure.
        await this.inboxDelivery.drainForTerminate(chatId);
        this.sessions.delete(chatId);
        this.sessionRuntimeStates.delete(chatId);
        this.recomputeRuntimeState();
        this._activeCount--;
      }
    }
  }

  private async resumeSession(entry: SessionEntry, message: SessionMessage | null | undefined): Promise<void> {
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
    if (!this.acquireActiveSlot(entry.chatId, slotMessage)) return;

    const ctx = this.buildSessionContext(entry.chatId);
    entry.status = "active";
    this._activeCount++;
    entry.lastActivity = Date.now();

    this.notifySessionState(entry.chatId, "active");
    this.projectSessionRuntime(entry.chatId);
    try {
      if (message) this.setCurrentTrigger(entry.chatId, message);
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
    } catch (err) {
      const classification = classify(err, { source: "session" });
      const handled = this.handleSessionFailure({
        entry,
        ctx,
        err,
        phase: "resume",
        classification,
      });
      if (!handled) {
        await this.inboxDelivery.drainForTerminate(entry.chatId);
        this.sessions.delete(entry.chatId);
        this.sessionRuntimeStates.delete(entry.chatId);
        this.recomputeRuntimeState();
        this._activeCount--;
      }
    }
  }

  /**
   * Decide what to do when handler.start / handler.resume rejects. Returns
   * `true` when the failure was handled as a transient retry (entry kept,
   * timer armed); `false` when the caller should run the permanent-failure
   * teardown.
   *
   * Bug 1 fix (client-resilience-design §5.1): transient errors keep the
   * entry around with an exponential-backoff retry. Permanent / degraded
   * errors fall through to the legacy F2 teardown path.
   */
  private handleSessionFailure(args: {
    entry: SessionEntry;
    ctx: SessionContext;
    err: unknown;
    phase: "start" | "resume";
    classification: Classification;
  }): boolean {
    const { entry, ctx, err, phase, classification } = args;
    const errMsg = err instanceof Error ? err.message : String(err);
    const chatId = entry.chatId;

    this.config.log.error(
      { chatId, err, phase, kind: classification.kind, reasonCode: classification.reasonCode },
      "session start/resume failed",
    );

    if (classification.kind === ERROR_KINDS.TRANSIENT) {
      entry.retryAttempt = clampRetryAttempt(entry.retryAttempt + 1);
      entry.lastRetryReason = classification.reasonCode;
      // Truncate the raw err message to 256 chars and persist it on the entry
      // so retry_started can include it too. The web UI renders the encoded
      // payload as text, so any operator looking at a `reasonCode:"unknown"` /
      // `git_unknown` retry can see the underlying err.message without
      // SSHing to the host. Crucially, run it through `redactErrorPreview`
      // first: `err.message` may include credentials echoed back by the
      // failing tool (e.g. `git clone https://user:PAT@github.com/...`),
      // and this payload leaves the `safe in logs but NOT chat` boundary
      // — see Classification.message's contract in error-taxonomy.ts.
      entry.lastRetryRawError = errMsg ? redactErrorPreview(errMsg, 256) : null;
      const delayMs = nextRetryDelayMs(classification.strategy, entry.retryAttempt);
      entry.retryNextAt = Date.now() + delayMs;
      // Drop the active slot now so other chats can use it during the
      // backoff window — the retry will re-acquire when it runs.
      //
      // Note: we flip `entry.status` to "suspended" locally but DELIBERATELY
      // skip `notifySessionState(chatId, "suspended")` here. `runRetry` will
      // re-report `active` within `delayMs` (capped at 5min), and bouncing
      // the server-side state through `active → suspended → active` on every
      // transient blip would only generate UI churn (chat presence chip
      // flickering, server-side state-change events firing twice per retry)
      // without giving operators new information. The `resilience.session.
      // retry_scheduled` event emitted just below is the canonical signal
      // for "we're in the backoff window". Server-side `agent_chat_sessions.
      // state` therefore stays `active` for the entire retry window.
      this._activeCount--;
      entry.status = "suspended";
      this.sessionRuntimeStates.delete(chatId);
      this.projectSessionRuntime(chatId);
      this.recomputeRuntimeState();

      this.config.log.info(
        {
          chatId,
          attempt: entry.retryAttempt,
          nextDelayMs: delayMs,
          reasonCode: classification.reasonCode,
          phase,
          resilienceEvent: "resilience.session.retry_scheduled",
        },
        "session transient failure — scheduling retry",
      );
      // Design §6.1: also emit through the SessionContext.emitEvent channel
      // so future server-side consumers see the signal. The closed kind-union
      // (sessionEventSchema) can't hold "resilience.session.retry_scheduled"
      // directly, so we encode it as a structured `error` event with the
      // resilience tag in the message prefix — see ResiliencePayload helper.
      try {
        ctx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: encodeResilienceMessage("resilience.session.retry_scheduled", {
              attempt: entry.retryAttempt,
              nextDelayMs: delayMs,
              reasonCode: classification.reasonCode,
              phase,
              rawError: entry.lastRetryRawError,
            }),
          },
        });
      } catch (emitErr) {
        this.config.log.warn({ chatId, emitErr }, "resilience retry_scheduled emit failed");
      }

      if (entry.retryTimer) clearTimeout(entry.retryTimer);
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        this.runRetry(chatId).catch((retryErr) => {
          this.config.log.warn({ chatId, retryErr }, "session retry failed");
        });
      }, delayMs);
      return true;
    }

    // Permanent / degraded — legacy F2 signalling (server state + structured
    // error event), then let caller tear down.
    entry.status = "errored";
    this.notifySessionState(chatId, "errored");
    this.projectSessionRuntime(chatId);
    try {
      // Same `safe in logs but NOT chat` boundary as the transient `rawError`
      // path above: the error message can legitimately echo back a git remote
      // URL with embedded credentials or a token-bearing SDK request, and this
      // event is rendered into chat-visible UI. Redact before slicing — slicing
      // first risks leaving a partial-token tail across the truncation point.
      const preview = redactErrorPreview(errMsg, 800);
      ctx.emitEvent({
        kind: "error",
        payload: {
          source: "runtime",
          message: `Session ${phase} failed: ${preview}`,
        },
      });
    } catch (emitErr) {
      this.config.log.warn({ chatId, emitErr }, "session error event emit failed");
    }
    return false;
  }

  /**
   * Re-attempt a session that previously hit a transient failure. Called by
   * the retry timer and by user-triggered immediate retry (see
   * `triggerImmediateRetry`). Re-builds the handler — the old one may have
   * had its SDK transport torn down.
   */
  private async runRetry(chatId: string): Promise<void> {
    const entry = this.sessions.get(chatId);
    if (!entry) return;
    if (entry.status === "active") return; // racing inject already revived it

    this.config.log.info(
      {
        chatId,
        attempt: entry.retryAttempt,
        reasonCode: entry.lastRetryReason,
        resilienceEvent: "resilience.session.retry_started",
      },
      "session transient retry — starting attempt",
    );
    // Design §6.1: emit via SessionContext.emitEvent (post-slot-acquire we
    // build the real ctx; here we use a lightweight onSessionEvent path).
    try {
      this.config.onSessionEvent?.(chatId, {
        kind: "error",
        payload: {
          source: "runtime",
          message: encodeResilienceMessage("resilience.session.retry_started", {
            attempt: entry.retryAttempt,
            reasonCode: entry.lastRetryReason,
            rawError: entry.lastRetryRawError,
          }),
        },
      });
    } catch (emitErr) {
      this.config.log.warn({ chatId, emitErr }, "resilience retry_started emit failed");
    }

    // Enforce concurrency limit before claiming the slot. If we cannot, the
    // entry stays in transient-retry state and a future retry / message will
    // try again.
    if (!this.acquireActiveSlot(chatId, entry.startMessage ?? buildEmptySessionMessage(chatId))) {
      // Couldn't get a slot — re-arm the timer with a short delay.
      const nextDelay = 5_000;
      entry.retryNextAt = Date.now() + nextDelay;
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = null;
        this.runRetry(chatId).catch((err) => {
          this.config.log.warn({ chatId, err }, "session retry rearm failed");
        });
      }, nextDelay);
      return;
    }

    entry.status = "active";
    this._activeCount++;
    entry.lastActivity = Date.now();

    // Fresh handler — the old one may have closed its SDK transport.
    const handlerCfg = this.config.agentConfigCache
      ? { ...this.config.handlerConfig, agentConfigCache: this.config.agentConfigCache }
      : this.config.handlerConfig;
    const newHandler = this.config.handlerFactory(handlerCfg);
    entry.handler = newHandler;
    const ctx = this.buildSessionContext(chatId);

    this.notifySessionState(chatId, "active");
    this.projectSessionRuntime(chatId);
    try {
      const resumeMessage = entry.startMessage ?? null;
      const previousSessionId = entry.claudeSessionId || entry.retryFromEvicted?.claudeSessionId || "";
      if (resumeMessage) this.setCurrentTrigger(chatId, resumeMessage);
      if (previousSessionId) {
        const sid = await newHandler.resume(resumeMessage ?? undefined, previousSessionId, ctx);
        entry.claudeSessionId = sid;
      } else {
        // No resume key yet — fall back to fresh start.
        const message = resumeMessage ?? buildEmptySessionMessage(chatId);
        const sid = await newHandler.start(message, ctx);
        entry.claudeSessionId = sid;
      }
      const totalAttempts = entry.retryAttempt;
      entry.retryAttempt = 0;
      entry.retryNextAt = null;
      entry.lastRetryReason = null;
      entry.lastRetryRawError = null;
      this.config.log.info(
        {
          chatId,
          sessionId: entry.claudeSessionId,
          resilienceEvent: "resilience.session.retry_succeeded",
        },
        "session transient retry succeeded",
      );
      try {
        ctx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: encodeResilienceMessage("resilience.session.retry_succeeded", {
              totalAttempts,
            }),
          },
        });
      } catch (emitErr) {
        this.config.log.warn({ chatId, emitErr }, "resilience retry_succeeded emit failed");
      }
      this.drainRetryQueuedMessages(entry);
      this.persistRegistry();
    } catch (err) {
      const classification = classify(err, { source: "session" });
      const handled = this.handleSessionFailure({
        entry,
        ctx,
        err,
        phase: previousAvailable(entry) ? "resume" : "start",
        classification,
      });
      if (!handled) {
        await this.inboxDelivery.drainForTerminate(chatId);
        this.sessions.delete(chatId);
        this.sessionRuntimeStates.delete(chatId);
        this.recomputeRuntimeState();
        this._activeCount--;
      }
    }
  }

  /**
   * Cancel any pending retry timer and re-run the retry now. Used when a new
   * user message arrives for a chat in transient-retry mode — the message is
   * a strong signal that the user is waiting, so don't make them sit through
   * the rest of the backoff window.
   */
  private triggerImmediateRetry(chatId: string): void {
    const entry = this.sessions.get(chatId);
    if (!entry || entry.retryAttempt === 0) return;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    void this.runRetry(chatId);
  }

  private drainRetryQueuedMessages(entry: SessionEntry): void {
    if (entry.retryQueuedMessages.length === 0) return;

    const queued = entry.retryQueuedMessages.splice(0);
    for (const message of queued) {
      this.setCurrentTrigger(entry.chatId, message);
      try {
        entry.handler.inject(message);
        entry.lastActivity = Date.now();
      } catch (err) {
        this.config.log.warn({ chatId: entry.chatId, messageId: message.id, err }, "retry queued inject failed");
        this.inboxDelivery.retryTurn(entry.chatId, message, "retry_queued_inject_failed");
        break;
      }
    }
    this.projectSessionRuntime(entry.chatId);
  }

  private setCurrentTrigger(chatId: string, message: SessionMessage): void {
    if (!message.id) return;
    this.currentTrigger.set(chatId, { messageId: message.id, senderId: message.senderId });
  }

  /**
   * Try to acquire an active slot. If at concurrency limit:
   * 1. Suspend the least-recently-active session to free a slot
   * 2. If no candidates, queue the message
   *
   * Returns true if slot acquired, false if queued. The in-flight entryId
   * is tracked separately in `InboxDeliveryCoordinator` (populated at dispatch),
   * so the queue doesn't carry inbox metadata.
   */
  private acquireActiveSlot(chatId: string, message: SessionMessage): boolean {
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
      this.suspendSession(oldestActive, { reason: "concurrency_preempted", ackConsumedPrefix: false });
      return true;
    }

    // All active sessions are busy — queue. The inbox entry stays in
    // the coordinator ledger until the eventual turn finishes.
    this.config.log.info({ chatId }, "concurrency limit reached, queuing");
    this.pendingQueue.push({ message, chatId });
    return false;
  }

  private suspendSession(
    entry: SessionEntry,
    opts: { reason: string; ackConsumedPrefix: boolean } = {
      reason: "session_suspended",
      ackConsumedPrefix: true,
    },
  ): void {
    const prepare = opts.ackConsumedPrefix
      ? this.inboxDelivery.prepareSuspend(entry.chatId, opts.reason)
      : Promise.resolve(this.inboxDelivery.prepareEvict(entry.chatId, opts.reason));
    entry.status = "suspended";
    this._activeCount--;
    // Clear per-session runtime state on suspend
    this.sessionRuntimeStates.delete(entry.chatId);
    this.recomputeRuntimeState();
    entry.suspending = prepare
      .then(() => entry.handler.suspend())
      .catch((err) => {
        this.config.log.warn({ chatId: entry.chatId, err }, "suspend preparation error");
      })
      .then(() => undefined)
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
    // Route asynchronously — the delivery work is already tracked by the
    // coordinator from the original `dispatch`.
    this.routeMessage(next.chatId, next.message).catch((err) => {
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
      this.inboxDelivery.prepareEvict(candidate.key, "session_evicted");
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
   *      (mid-turn message), and the handler's provider-activity callback.
   *   2. The coordinator is the source of truth for unsettled delivery work.
   *      If a chat has tracked / consumed / ACK-pending entries or recovery
   *      debt, the reaper must not treat it as idle before the hard cap.
   *   3. `working_grace_seconds` is an UPPER bound on how long unsettled work
   *      can hold a slot past `idle_timeout`.
   */
  private evictIdle(): void {
    const timeoutMs = this.config.session.idle_timeout * 1000;
    const workingGraceMs = this.config.session.working_grace_seconds * 1000;
    const now = Date.now();

    for (const [, session] of this.sessions) {
      if (session.status !== "active") continue;
      const inactiveMs = now - session.lastActivity;
      if (inactiveMs <= timeoutMs) continue;

      const currentState = this.sessionRuntimeStates.get(session.chatId);
      const hasUnsettledWork = this.inboxDelivery.hasUnsettledWork(session.chatId);

      // Hard cap: regardless of unsettled work, once we are past
      // `idle_timeout + working_grace_seconds` the slot MUST be reclaimed.
      // Anything else means a stuck handler can hold a slot forever just
      // by never closing the delivery work.
      const pastHardCap = inactiveMs >= timeoutMs + workingGraceMs;

      if (hasUnsettledWork && !pastHardCap) {
        this.config.log.info(
          {
            chatId: session.chatId,
            runtimeState: currentState,
            inactiveSec: Math.round(inactiveMs / 1000),
            graceSec: this.config.session.working_grace_seconds,
          },
          "session idle threshold reached but inbox work is unsettled — skipping suspend",
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
    // Resolve the self-fence SYNCHRONOUSLY from the already-populated config
    // cache so it can ride the agent's env (`buildAgentEnv` is sync). This
    // lets a `<binName> chat send` sub-process snapshot referenced docs
    // exactly like result-sink does (L3: unify capture across send paths).
    // result-sink keeps its own async `getSelfFence`; both read the same cache
    // (`refreshIfNewer(_, 0)` returns the cached payload), so the fence they
    // compute agrees. The legacy `base` env var (`FIRST_TREE_DOC_BASE`) is
    // kept emitting the OLD source-repo-top semantics so a stale pre-fix
    // `chat send` binary inherited from this process still snapshots like it
    // used to — see `agent-io.ts` for the wire-compat plumbing.
    const sessionRoot = resolveSessionDocRoot(this.config.handlerConfig.workspaceRoot, chatId);
    const cachedPayload = this.config.agentConfigCache?.get(this.config.agentIdentity.agentId)?.payload ?? null;
    const selfFence = selfFenceFromRuntimeConfig(cachedPayload, sessionRoot);
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
      getSelfFence: () => this.resolveSelfFence(log, chatId),
      workspacesRoot,
      selfSlug,
    });

    const envCtx = {
      sdk: this.config.sdk,
      agent: this.config.agentIdentity,
      chatId,
      docContext: {
        base: docBase,
        agentHome: selfFence.agentHome,
        singleRepoLocalPath: selfFence.singleRepoLocalPath,
        workspacesRoot,
        selfSlug,
      },
    };

    return {
      agent: this.config.agentIdentity,
      sdk: this.config.sdk,
      log,
      chatId,
      recordProviderActivity: () => {
        const entry = this.sessions.get(chatId);
        if (entry && entry.status === "active") {
          entry.lastActivity = Date.now();
        }
      },
      emitEvent: (event) => {
        this.config.onSessionEvent?.(chatId, event);
      },
      forwardResult,
      markMessagesConsumed: (messages) => {
        this.inboxDelivery.markConsumed(chatId, messages);
      },
      finishTurn: (messages, outcome) => {
        return this.inboxDelivery.finishTurn(chatId, messages, outcome);
      },
      retryTurn: (messages, reason) => {
        this.inboxDelivery.retryTurn(chatId, messages, reason);
      },
      buildAgentEnv: (parentEnv) => buildAgentEnv(parentEnv, envCtx),
      formatInboundContent: (message) => formatInboundContent(message, participants),
      resolveSenderLabel: async (senderId) => resolveSenderLabel(senderId, await participants.get()),
    };
  }

  private async resolveSelfFence(log: (msg: string) => void, chatId: string): Promise<SelfFence> {
    // Session doc root: the dir the handler actually hands the agent as cwd —
    // the per-agent home for new chats, the legacy `<workspaceRoot>/<chatId>/`
    // dir for pre-#506 chats. See `resolveSessionDocRoot` (read-only existsSync;
    // no acquire* side effects on every outbound message).
    const sessionRoot = resolveSessionDocRoot(this.config.handlerConfig.workspaceRoot, chatId);
    if (!this.config.agentConfigCache) return { agentHome: sessionRoot };
    try {
      const { payload } = await this.config.agentConfigCache.refreshIfNewer(this.config.agentIdentity.agentId, 0);
      return selfFenceFromRuntimeConfig(payload, sessionRoot);
    } catch (err) {
      log(
        `document preview self-fence: config unavailable, using agent home only: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { agentHome: sessionRoot };
    }
  }

  private projectSessionRuntime(chatId: string): void {
    const session = this.sessions.get(chatId);
    const state = this.projectedRuntimeState(chatId, session ?? null);
    if (!state) {
      if (this.sessionRuntimeStates.delete(chatId)) this.recomputeRuntimeState();
      return;
    }
    if (this.sessionRuntimeStates.get(chatId) === state) return;
    this.sessionRuntimeStates.set(chatId, state);
    this.config.onSessionRuntimeChange?.(chatId, state);
    this.recomputeRuntimeState();
  }

  private projectedRuntimeState(chatId: string, session: SessionEntry | null): RuntimeState | null {
    if (!session) return null;
    if (session.status === "errored") return "error";
    if (session.status !== "active") return null;
    return this.inboxDelivery.hasUnsettledWork(chatId) ? "working" : "idle";
  }

  /**
   * Re-affirm working / blocked / error sessions so the server-side
   * freshness stamp doesn't lapse mid-turn. Reports only — does NOT
   * touch `lastActivity` (that governs idle eviction and must not be
   * reset by a liveness ping). `idle` is deliberately omitted: the
   * server treats it as the fail-closed default after the stale window
   * expires, so re-affirming idle is pure wire noise.
   */
  private reaffirmRuntimeStates(): void {
    if (!this.config.onSessionRuntimeChange) return;
    for (const [chatId, session] of this.sessions) {
      if (session.status !== "active" && session.status !== "errored") continue;
      const state = this.sessionRuntimeStates.get(chatId);
      if (state === "working" || state === "error") {
        this.config.onSessionRuntimeChange(chatId, state);
      }
    }
  }

  /**
   * Per-chat runtime snapshot for `fullStateSync` after reconnect. Lets
   * the agent-slot re-report the *real* per-chat runtime on a network
   * reconnect — a session mid-turn reports `working` rather than blanket-
   * idling. Only `status === 'active'` sessions are returned; a session
   * with no recorded runtime defaults to `idle`.
   */
  getSessionRuntimeStates(): Array<{ chatId: string; runtimeState: RuntimeState }> {
    const out: Array<{ chatId: string; runtimeState: RuntimeState }> = [];
    for (const [chatId, session] of this.sessions) {
      const runtimeState = this.projectedRuntimeState(chatId, session);
      if (!runtimeState) continue;
      out.push({ chatId, runtimeState });
    }
    return out;
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
      inboxEntryId: entry.id,
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

  private persistRegistry(opts: { immediate?: boolean } = {}): void {
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
    // On shutdown we MUST write synchronously: the alternative is
    // `save()` (debounced 1s) followed by `dispose()`, which races the
    // process exit and silently drops the last mapping batch.
    if (opts.immediate) this.registry.flush(entries);
    else this.registry.save(entries);
  }
}
