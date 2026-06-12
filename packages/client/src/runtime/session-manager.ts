import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AgentRuntimeConfigPayload,
  GitRepo,
  InboxEntryWithMessage,
  RuntimeState,
  SessionEvent,
  SessionState,
  WorkspaceHealthMessage,
  WorkspaceRepoHealth,
} from "@first-tree/shared";
import {
  deriveRepoLocalPath,
  isImageBatchRefContent,
  isImageRefContent,
  workspaceTreeHealthSchema,
} from "@first-tree/shared";
import type { pino } from "../observability/logger.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentConfigCache } from "./agent-config-cache.js";
import { buildAgentEnv, createParticipantCache, formatInboundContent, resolveSenderLabel } from "./agent-io.js";
import { type ContextTreeSyncResult, syncAgentContextTreeWithHealth } from "./bootstrap.js";
import type { SessionConfig } from "./config.js";
import { reresolveUnboundTree } from "./context-tree-rebind.js";
import { Deduplicator } from "./deduplicator.js";
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
   * `syncAgentContextTreeWithHealth(sdk)`; injected as a stub in tests to
   * avoid spawning real git. The result's `health` half refreshes
   * `handlerConfig.contextTreeHealth` so the next `workspace:health` frame
   * carries the freshest tree verdict.
   */
  resolveContextTreeBinding?: () => Promise<ContextTreeSyncResult>;
  /**
   * Callback fired when a handler finishes materialising its source repos and
   * reports per-repo workspace health (degraded-workspace startup). The
   * SessionManager composes the frame's tree half from
   * `handlerConfig.contextTreeHealth`; wired by AgentSlot to
   * `clientConnection.reportWorkspaceHealth`.
   */
  onWorkspaceHealth?: (health: WorkspaceHealthMessage) => void;
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

type TrackedInFlightEntry = {
  entryId: number;
  messageId: string;
  dedupKey: string;
  accepted: boolean;
  consumed: boolean;
};

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
  /** Last lazy Context-Tree re-resolution attempt (epoch ms); see `TREE_RERESOLVE_INTERVAL_MS`. */
  private lastTreeResolveAttemptAt = 0;
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
  /**
   * In-flight inbox entries per chat — delivered entries that this process
   * has handed toward a handler and has not yet committed. Completion is
   * identity based: handlers report the concrete SessionMessage or fused
   * batch they actually consumed, and the runtime sends one ack-through for
   * that batch's last inbox entry.
   *
   * Kept here (not on `SessionEntry`) because dispatch may push an entryId
   * before any session record exists for the chat (`startNewSession` runs
   * `routeMessage` first), and the queue must survive a session being
   * suspended / evicted between dispatch and markCompleted.
   *
   * Sized small in practice: usually 1, briefly up to N when several
   * messages land while a turn is mid-flight. Entries that were delivered
   * but only queued inside a handler remain tracked until the handler's
   * actual consuming turn calls `markMessagesCompleted`.
   * See
   * docs/inflight-message-recovery-design.md §4.
   */
  private readonly inFlightEntries = new Map<string, TrackedInFlightEntry[]>();
  /**
   * Per-chat admission barrier. It serializes the pre-handler admission phase
   * only: config refresh, eager asset fetch, marking the entry accepted, and
   * invoking `routeMessage()`. It deliberately does NOT wait for the handler's
   * turn promise to settle, so A2 can still be appended/injected while A1's
   * attempt is running; it just cannot overtake A1 before A1 reaches handler
   * membership.
   */
  private readonly admissionQueues = new Map<string, Promise<void>>();
  private readonly recoveringChats = new Map<string, Promise<void>>();
  private readonly recoveryActivationReady = new Set<string>();
  private readonly requiresInboxRecovery = new Set<string>();
  private readonly pendingQueue: PendingMessage[] = [];
  private readonly lastReportedStates = new Map<string, SessionState>();
  private readonly sessionRuntimeStates = new Map<string, RuntimeState>();
  private lastReportedRuntimeState: RuntimeState | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeReaffirmTimer: ReturnType<typeof setTimeout> | null = null;
  private _activeCount = 0;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.registry = config.registryPath ? new SessionRegistry(config.registryPath) : null;
    this.idleTimer = setInterval(() => this.evictIdle(), 10_000);
    // Independent of `evictIdle` (which early-continues on freshly-active
    // sessions): re-affirm working / blocked / error sessions so the
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
   * completed turn via `ctx.markMessagesCompleted(...)`.
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

    if (this.shouldRecoverBeforeDispatch(chatId)) {
      await this.recoverChatBeforeDispatch(chatId, entry.id, messageId);
      return;
    }

    // 1. Deduplication — key by (chatId, messageId). Dedup is now only an
    // in-process duplicate-injection guard for entries still tracked by the
    // active local turn/batch. It must not independently re-ack: ack-through
    // can commit older delivered prefix rows, so only a concrete successful
    // turn completion may send the cursor.
    const dedupKey = `${chatId}:${messageId}`;
    if (this.deduplicator.isDuplicate(dedupKey)) {
      const queue = this.inFlightEntries.get(chatId);
      const stillInFlight = queue ? queue.some((tracked) => tracked.entryId === entry.id) : false;
      this.config.log.debug({ chatId, messageId, entryId: entry.id, stillInFlight }, "duplicate message observed");
      if (stillInFlight) return;
      this.config.log.debug(
        { chatId, messageId, entryId: entry.id },
        "duplicate key is not tied to an active entry; reprocessing redelivery",
      );
    }

    // Track before routing. The handler (or teardown path) commits by
    // message identity once work is complete; nothing acks until then.
    const queue = this.inFlightEntries.get(chatId);
    const tracked = { entryId: entry.id, messageId, dedupKey, accepted: false, consumed: false };
    if (queue) queue.push(tracked);
    else this.inFlightEntries.set(chatId, [tracked]);

    let routePromise: Promise<void> | undefined;
    await this.withAdmissionBarrier(chatId, async () => {
      if (!this.isTrackedEntry(chatId, entry.id)) return;

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

      if (!this.isTrackedEntry(chatId, entry.id)) return;

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

      if (!this.markTrackedEntryAccepted(chatId, entry.id)) return;

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
      // entry sits in `inFlightEntries` until the handler completes the
      // concrete message/batch it actually consumed. Do not await inside the
      // admission barrier: for Codex/TUI, route promises can span the whole
      // turn, but same-chat later messages must still be able to append once
      // this entry has reached handler membership.
      routePromise = this.routeMessage(chatId, message).catch((err) => {
        if (this.isTrackedEntry(chatId, entry.id)) {
          this.clearInFlightForRecovery(chatId, "route_message_failed");
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

      // Terminate is operator-intent — ack every queued in-flight entry
      // so the server doesn't redeliver them on the next bind. Server-side
      // pushed messages get silently dropped here; this is the documented
      // terminate semantics (operator chose to wipe this chat's session,
      // anything mid-flight is collateral).
      this.drainAllInFlightEntries(chatId);

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
   * by `dispatch` when no healthy live handler exists.
   */
  noteBindRecoveryComplete(): void {
    // Intentionally no-op.
  }

  // ---- Internal -----------------------------------------------------------

  private async withAdmissionBarrier(chatId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.admissionQueues.get(chatId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.admissionQueues.set(chatId, next);
    const cleanup = () => {
      if (this.admissionQueues.get(chatId) === next) this.admissionQueues.delete(chatId);
    };
    void next.then(cleanup, cleanup);
    await next;
  }

  private isTrackedEntry(chatId: string, entryId: number): boolean {
    return this.inFlightEntries.get(chatId)?.some((tracked) => tracked.entryId === entryId) ?? false;
  }

  private markTrackedEntryAccepted(chatId: string, entryId: number): boolean {
    const tracked = this.inFlightEntries.get(chatId)?.find((entry) => entry.entryId === entryId);
    if (!tracked) return false;
    tracked.accepted = true;
    return true;
  }

  private hasHealthyLiveHandler(chatId: string): boolean {
    const entry = this.sessions.get(chatId);
    return entry?.status === "active" && entry.suspending === null;
  }

  private shouldRecoverBeforeDispatch(chatId: string): boolean {
    if (this.recoveryActivationReady.has(chatId)) {
      this.recoveryActivationReady.delete(chatId);
      return false;
    }
    if (this.requiresInboxRecovery.has(chatId)) return true;
    return Boolean(this.config.recoverChat) && !this.hasHealthyLiveHandler(chatId);
  }

  private async recoverChatBeforeDispatch(chatId: string, entryId: number, messageId: string): Promise<void> {
    const existing = this.recoveringChats.get(chatId);
    if (existing) {
      await existing;
      return;
    }
    const recoverChat = this.config.recoverChat;
    if (!recoverChat) {
      this.config.log.error(
        { chatId, entryId, messageId },
        "chat requires inbox recovery but no recoverChat callback is configured; deferring dispatch",
      );
      return;
    }

    let recovery: Promise<void>;
    recovery = recoverChat(chatId)
      .then(() => {
        this.requiresInboxRecovery.delete(chatId);
        this.recoveryActivationReady.add(chatId);
        this.config.log.debug({ chatId, entryId, messageId }, "chat inbox recovery accepted before dispatch");
      })
      .catch((err) => {
        this.config.log.warn({ chatId, entryId, messageId, err }, "chat inbox recovery failed before dispatch");
      })
      .finally(() => {
        if (this.recoveringChats.get(chatId) === recovery) this.recoveringChats.delete(chatId);
      });
    this.recoveringChats.set(chatId, recovery);
    await recovery;
  }

  private async routeMessage(chatId: string, message: SessionMessage): Promise<void> {
    // Record the trigger BEFORE dispatching to any handler path (start /
    // resume / inject) so the resultSink constructed in buildSessionContext
    // sees the right messageId+senderId when this turn eventually produces a
    // reply. The sink clears it on forward so an intervening inject() can
    // overwrite it without the in-flight reply stealing the new trigger.
    if (message.id) {
      this.currentTrigger.set(chatId, { messageId: message.id, senderId: message.senderId });
    }

    const existing = this.sessions.get(chatId);

    // Transient retry path: an earlier handler.start / handler.resume failed
    // with a classified-transient error and we kept the entry around. A new
    // user message is a strong signal the user is waiting — replace the
    // stored startMessage so the retry uses the fresher content, then fire
    // an immediate retry. The new entry sits alongside any prior entries in
    // `inFlightEntries[chatId]`; the retry's eventual forwardResult commits
    // the concrete message/batch it consumed.
    if (existing && existing.retryAttempt > 0) {
      existing.startMessage = message;
      this.triggerImmediateRetry(chatId);
      return;
    }

    if (existing) {
      switch (existing.status) {
        case "active":
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
      (() => syncAgentContextTreeWithHealth(this.config.sdk, (msg) => this.config.log.info(msg)));
    const result = await reresolveUnboundTree(cfg.contextTreePath, resolve);
    if (!result) return;
    // Record the freshest tree-side health verdict even when the slot stays
    // tree-less — a re-resolution distinguishes "org has no tree" (unbound)
    // from "bound but this machine can't reach it" (unreachable), and the
    // next `workspace:health` frame should carry whichever it found.
    // `health === null` = config fetch failed (unknown) → keep the prior value.
    if (result.health !== null) cfg.contextTreeHealth = result.health;
    const binding = result.binding;
    if (!binding) return;
    cfg.contextTreePath = binding.path;
    cfg.contextTreeRepoUrl = binding.repoUrl;
    cfg.contextTreeBranch = binding.branch;
    this.config.log.info(
      { path: binding.path, repoUrl: binding.repoUrl },
      "context tree binding resolved lazily (agent was unbound at slot start)",
    );
  }

  /**
   * Compose and emit a `workspace:health` report: the handler's per-repo
   * verdicts plus the tree half read from `handlerConfig.contextTreeHealth`
   * (set by AgentSlot at bind, refreshed by `ensureContextTreeBinding`).
   *
   * Skipped entirely when the tree half is unknown (slot bind couldn't fetch
   * the tree config) — the server keeps the last good latest-wins report
   * rather than having it overwritten by a half-blind one.
   */
  private reportWorkspaceHealth(repos: WorkspaceRepoHealth[]): void {
    if (!this.config.onWorkspaceHealth) return;
    const parsed = workspaceTreeHealthSchema.safeParse(this.config.handlerConfig.contextTreeHealth);
    if (!parsed.success) {
      this.config.log.debug(
        { repoCount: repos.length },
        "workspace:health report skipped — tree health unknown (context tree config not resolved)",
      );
      return;
    }
    this.config.onWorkspaceHealth({ tree: parsed.data, repos });
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
      retryFromEvicted: evicted ?? null,
    };

    this.sessions.set(chatId, entry);
    this._activeCount++;
    if (evicted) this.evictedMappings.delete(chatId);

    // Report `active` BEFORE invoking handler.start / handler.resume. Handlers
    // can call `ctx.setRuntimeState("working")` synchronously inside start()
    // (claude-code does; codex always does — its handler awaits the whole
    // turn before returning, so the initial working AND final idle reports
    // both fire from inside start()). Those `session:runtime` frames are
    // active-gated on the server, so they would be dropped if the
    // `session:state active` write hadn't landed yet — leaving the composite
    // stuck at `ready` until a reaffirm (or never, for short turns). The
    // server's `upsertSessionState` short-circuits same-state reports, and
    // `notifySessionState` here additionally dedupes against the last
    // reported value, so doing it before AND after is harmless if a future
    // refactor adds a second site. Failure path replaces this `active` with
    // `errored` in the catch below (different state → goes through).
    this.notifySessionState(chatId, "active");
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
        this.drainAllInFlightEntries(chatId);
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

    // Same rationale as `startNewSession`: report `active` BEFORE invoking
    // the handler so any synchronous `ctx.setRuntimeState("working")` inside
    // handler.resume() lands on a server row that is already active-gated.
    // Failure path overrides with `errored` in the catch below.
    this.notifySessionState(entry.chatId, "active");
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
        this.drainAllInFlightEntries(entry.chatId);
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
    this.notifySessionState(chatId, "errored");
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
    try {
      const resumeMessage = entry.startMessage ?? null;
      const previousSessionId = entry.claudeSessionId || entry.retryFromEvicted?.claudeSessionId || "";
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
        this.drainAllInFlightEntries(chatId);
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

  /**
   * Try to acquire an active slot. If at concurrency limit:
   * 1. Suspend the least-recently-active session to free a slot
   * 2. If no candidates, queue the message
   *
   * Returns true if slot acquired, false if queued. The in-flight entryId
   * is tracked separately in `inFlightEntries` (populated at dispatch),
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
      this.suspendSession(oldestActive);
      return true;
    }

    // All active sessions are busy — queue. The inbox entry stays in
    // `inFlightEntries[chatId]` until the eventual turn finishes.
    this.config.log.info({ chatId }, "concurrency limit reached, queuing");
    this.pendingQueue.push({ message, chatId });
    return false;
  }

  private suspendSession(entry: SessionEntry): void {
    this.ackConsumedInFlightForSuspend(entry.chatId);
    this.clearInFlightForRecovery(entry.chatId, "session_suspended_unconsumed_tail");
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
    // Route asynchronously — the in-flight entryId for this message is
    // already in `inFlightEntries[chatId]` from the original `dispatch`.
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
      // Drop local in-flight tracking too — the handler is gone, so no
      // markCompleted will ever fire. The server-side entries stay
      // `delivered`; a later chat recovery or bind reset redelivers them
      // against a fresh session.
      this.clearInFlightForRecovery(candidate.key, "session_evicted");
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

  private ackThroughTrackedEntry(chatId: string, throughEntryId: number): void {
    const queue = this.inFlightEntries.get(chatId);
    if (!queue || queue.length === 0) return;
    const index = queue.findIndex((tracked) => tracked.entryId === throughEntryId);
    if (index < 0) {
      this.config.log.warn({ chatId, throughEntryId }, "attempt completion ignored for untracked inbox entry");
      return;
    }

    const committed = queue.splice(0, index + 1);
    for (const tracked of committed) {
      this.deduplicator.drop(tracked.dedupKey);
    }
    if (queue.length === 0) this.inFlightEntries.delete(chatId);

    this.config.ackEntry(throughEntryId).catch((err) => {
      this.config.log.warn({ chatId, entryId: throughEntryId, err }, "ACK-through failed, continuing");
    });
  }

  private ackOldestTrackedEntry(chatId: string): void {
    const entryId = this.inFlightEntries.get(chatId)?.[0]?.entryId;
    if (entryId !== undefined) this.ackThroughTrackedEntry(chatId, entryId);
  }

  private clearInFlightForRecovery(chatId: string, reason: string): void {
    const queue = this.inFlightEntries.get(chatId);
    if (!queue || queue.length === 0) return;
    this.inFlightEntries.delete(chatId);
    this.deduplicator.dropByPrefix(`${chatId}:`);
    this.requiresInboxRecovery.add(chatId);
    this.config.log.warn(
      { chatId, reason, entryIds: queue.map((entry) => entry.entryId) },
      "cleared local in-flight inbox entries; waiting for recovery redelivery",
    );
  }

  private ackConsumedInFlightForSuspend(chatId: string): void {
    const queue = this.inFlightEntries.get(chatId);
    if (!queue || queue.length === 0) return;

    let consumedPrefixCount = 0;
    for (const tracked of queue) {
      if (!tracked.consumed) break;
      consumedPrefixCount++;
    }
    if (consumedPrefixCount === 0) return;

    const lastConsumed = queue[consumedPrefixCount - 1];
    if (lastConsumed) this.ackThroughTrackedEntry(chatId, lastConsumed.entryId);
  }

  private markMessagesConsumed(chatId: string, messages: SessionMessage | readonly SessionMessage[]): void {
    const queue = this.inFlightEntries.get(chatId);
    if (!queue || queue.length === 0) return;
    const batch = Array.isArray(messages) ? messages : [messages];
    const consumedIds = new Set<number>();
    for (const message of batch) {
      if (message.chatId === chatId && message.inboxEntryId !== undefined) consumedIds.add(message.inboxEntryId);
    }
    if (consumedIds.size === 0) return;
    for (const tracked of queue) {
      if (consumedIds.has(tracked.entryId)) tracked.consumed = true;
    }
  }

  private markMessagesCompleted(chatId: string, messages: SessionMessage | readonly SessionMessage[]): void {
    const batch = Array.isArray(messages) ? messages : [messages];
    let throughEntryId: number | undefined;
    for (const message of batch) {
      if (message.chatId !== chatId) continue;
      if (message.inboxEntryId !== undefined) throughEntryId = message.inboxEntryId;
    }
    if (throughEntryId === undefined) {
      this.config.log.warn({ chatId }, "attempt completion ignored because no inboxEntryId was provided");
      return;
    }
    this.ackThroughTrackedEntry(chatId, throughEntryId);
  }

  private markMessagesRetryable(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reason: string,
  ): void {
    const batch = Array.isArray(messages) ? messages : [messages];
    const hasTrackedMessage = batch.some(
      (message) =>
        message.chatId === chatId &&
        message.inboxEntryId !== undefined &&
        (this.inFlightEntries.get(chatId) ?? []).some((entry) => entry.entryId === message.inboxEntryId),
    );
    if (!hasTrackedMessage) return;
    this.clearInFlightForRecovery(chatId, reason);
  }

  /**
   * Drain every in-flight entry for this chat and ack them all. Used by
   * the runtime on `session:terminate` (operator intent — every queued
   * entry is doomed) and on permanent `handler.start` / `handler.resume`
   * failure (re-handling on redelivery would re-hit the same permanent
   * error, so acking avoids a loop). NOT to be called from handlers — the
   * per-turn pairing path is `markMessagesCompleted(messageOrBatch)`.
   */
  private drainAllInFlightEntries(chatId: string): void {
    const queue = this.inFlightEntries.get(chatId);
    if (!queue || queue.length === 0) return;
    let acceptedPrefixCount = 0;
    for (const tracked of queue) {
      if (!tracked.accepted) break;
      acceptedPrefixCount++;
    }
    if (acceptedPrefixCount > 0) {
      const lastAccepted = queue[acceptedPrefixCount - 1];
      if (lastAccepted) this.ackThroughTrackedEntry(chatId, lastAccepted.entryId);
    }
    if (this.inFlightEntries.has(chatId)) {
      this.clearInFlightForRecovery(chatId, "drain_unaccepted_remainder");
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
      markCompleted: () => {
        this.ackOldestTrackedEntry(chatId);
      },
      markMessagesConsumed: (messages) => {
        this.markMessagesConsumed(chatId, messages);
      },
      markMessagesCompleted: (messages) => {
        this.markMessagesCompleted(chatId, messages);
      },
      markMessagesRetryable: (messages, reason) => {
        this.markMessagesRetryable(chatId, messages, reason);
      },
      buildAgentEnv: (parentEnv) => buildAgentEnv(parentEnv, envCtx),
      formatInboundContent: (message) => formatInboundContent(message, participants),
      resolveSenderLabel: async (senderId) => resolveSenderLabel(senderId, await participants.get()),
      reportRepoHealth: (repos) => {
        this.reportWorkspaceHealth(repos);
      },
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

  /** Update per-session runtime state and recompute aggregate. Only active sessions may update. */
  private setSessionRuntimeState(chatId: string, state: RuntimeState): void {
    const session = this.sessions.get(chatId);
    if (!session || session.status !== "active") return;
    this.sessionRuntimeStates.set(chatId, state);
    // Per-chat D-axis report: the authoritative source the server-side
    // composite reads. Fire before recomputing the agent-global aggregate
    // so a single state change drops one frame on each wire (the per-chat
    // and the agent-global one), in that order — making it harmless if
    // either consumer races the other.
    this.config.onSessionRuntimeChange?.(chatId, state);
    this.recomputeRuntimeState();
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
      if (session.status !== "active") continue;
      const state = this.sessionRuntimeStates.get(chatId);
      if (state === "working" || state === "blocked" || state === "error") {
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
      if (session.status !== "active") continue;
      out.push({ chatId, runtimeState: this.sessionRuntimeStates.get(chatId) ?? "idle" });
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
