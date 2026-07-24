import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type {
  AgentRuntimeConfigPayload,
  GitRepo,
  InboxEntryWithMessage,
  ProviderRetryEventPayload,
  RuntimeProvider,
  RuntimeState,
  SessionEvent,
  SessionState,
} from "@first-tree/shared";
import {
  attachmentRefsFromMetadata,
  deriveRepoLocalPath,
  encodeProviderRetryEventMessage,
  imageAttachmentRefsFromMetadata,
  isImageBatchRefContent,
  isImageRefContent,
  MAX_MESSAGE_ATTACHMENT_REFS,
  parseProviderRetryEventMessage,
  runtimeProviderSchema,
  SOURCE_REPOS_DIRNAME,
} from "@first-tree/shared";
import type { pino } from "../observability/logger.js";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { AgentConfigCache } from "./agent-config-cache.js";
import {
  buildAgentEnv,
  buildFromHeader,
  createParticipantCache,
  formatInboundContent,
  resolveSenderLabel,
} from "./agent-io.js";
import { findAttachmentFile, writeAttachmentFile } from "./attachment-store.js";
import { type ContextTreeBinding, resolveAgentContextTreeBinding } from "./bootstrap.js";
import type { SessionConfig } from "./config.js";
import { reresolveUnboundTree } from "./context-tree-rebind.js";
import type { SelfFence } from "./doc-snapshots.js";
import { clampRetryAttempt } from "./error-taxonomy.js";
import type {
  AgentHandler,
  AgentIdentity,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  HandlerRouteReceipt,
  ResumeResult,
  SessionContext,
  SessionMessage,
  StartResult,
  TurnOutcome,
} from "./handler.js";
import { findImagePath, writeImage } from "./image-store.js";
import { type DeliveryRouteOwnership, InboxDeliveryCoordinator } from "./inbox-delivery-coordinator.js";
import type { SubprocessProbe } from "./process-tree-probe.js";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  type ProviderFailureClassification,
} from "./provider-retry-policy.js";
import { redactErrorPreview } from "./redact-error-preview.js";
import { createResultSink, type Trigger } from "./result-sink.js";
import { postProviderFailureRuntimeNotice, shouldPostProviderFailureRuntimeNotice } from "./runtime-notice.js";
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
  lastRetryCategory: ProviderFailureClassification["category"] | null;
  lastRetryScope: "session_start" | "session_resume" | null;
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
   * Latest terminal, user-actionable provider failure observed on the session
   * event channel. Posting the durable chat notice at the delivery-settlement
   * boundary keeps the policy centralized: handlers classify and emit
   * `provider.retry`, while SessionManager decides whether ACK may consume the
   * user's inbox entry. Non-consuming delivery paths clear this cache so a
   * provider failure from one delivery cannot be posted as evidence for a later
   * delivery on the same session.
   */
  pendingRuntimeFailureNotice: ProviderRetryEventPayload | null;
  /**
   * When we entered transient-retry mode this is set to the evicted mapping
   * captured at startNewSession time. Lets a retry re-use the same resume
   * path (handler.resume) instead of regressing to handler.start.
   */
  retryFromEvicted: { claudeSessionId: string; lastActivity: number } | null;
};

type SessionFailureHandling =
  | { kind: "retry" }
  | { kind: "terminal"; reasonCode: string; terminalEventPersisted: boolean };

export type SessionManagerShutdownOptions = {
  /**
   * Runtime switches are destructive: server-side switch-runtime has already
   * archived/evicted chat sessions, so the retiring local slot must not write
   * old handler resume mappings back to disk.
   */
  clearPersistedRegistry?: boolean;
  /** Ordinary daemon shutdown reports live sessions as suspended; runtime switches skip that. */
  reportSuspendedSessions?: boolean;
};

type PendingMessage = {
  message: SessionMessage | null;
  chatId: string;
  deliveryKind: SlotDeliveryKind;
};

type SlotDeliveryKind = "fresh" | "recovery" | "control";

type SessionCommandType = "session:suspend" | "session:resume" | "session:terminate";
type RuntimeSyncActiveSet = ReadonlySet<string> | null;

/**
 * Resolve the directory the runtime reads markdown doc snapshots against —
 * the same dir the handler actually hands the agent as cwd for this chat.
 *
 * Two layouts coexist after the per-agent-home redesign (#506) and its
 * legacy-resume hotfix (#530):
 *  - NEW chats run cwd = the per-agent home (`<workspaceRoot>` itself, see
 *    `acquireAgentHome`), with predeclared source repos materialised under the
 *    `source-repos/` dir (`<workspaceRoot>/source-repos/<localPath>`). No
 *    `<workspaceRoot>/<chatId>/` dir is ever created.
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
 *      `handlers/codex/`; #530 left codex alone because its transcripts are
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
 *  - exactly one repo → that source repo's clone, the unambiguous markdown-link
 *    root, as an ABSOLUTE path. Returning a bare relative `localPath` (the old
 *    behaviour) made the runtime resolve it against its own `process.cwd()` —
 *    the launch dir, not the session workspace — so cloud preview was dead.
 *    The `source-repos/` layer applies ONLY to the new agent-home layout
 *    (`sessionRoot === workspaceRoot`): the clone is at
 *    `<workspaceRoot>/source-repos/<localPath>`. A legacy pre-#506 per-chat
 *    session (`sessionRoot` is `<workspaceRoot>/<chatId>`, NOT the agent home)
 *    keeps its prior flat base `<sessionRoot>/<localPath>` — that layout never
 *    had a `source-repos/` layer, so prepending one would point preview at a
 *    directory that does not exist.
 *  - zero or multiple repos → the session doc root.
 */
export function documentBasePathFromRuntimeConfig(
  payload: AgentRuntimeConfigPayload,
  sessionRoot: string,
  workspaceRoot: string,
): string {
  const localPath = singleRepoLocalPathFromPayload(payload);
  if (!localPath) return sessionRoot;
  // New agent-home layout only: source clones live under `source-repos/`.
  return sessionRoot === workspaceRoot
    ? join(sessionRoot, SOURCE_REPOS_DIRNAME, localPath)
    : join(sessionRoot, localPath);
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
export function selfFenceFromRuntimeConfig(
  payload: AgentRuntimeConfigPayload | null,
  sessionRoot: string,
  workspaceRoot: string,
): SelfFence {
  if (!payload) return { agentHome: sessionRoot };
  const name = singleRepoLocalPathFromPayload(payload);
  if (!name) return { agentHome: sessionRoot };
  // `singleRepoLocalPath` is the source repo's path RELATIVE to `agentHome`
  // (the snapshot pipeline resolves it as `resolve(agentHome, …)`). The
  // `source-repos/` layer applies ONLY to the new agent-home layout
  // (`sessionRoot === workspaceRoot`); a legacy pre-#506 per-chat session keeps
  // its prior flat relative path `<name>`, matching `documentBasePathFromRuntimeConfig`.
  const singleRepoLocalPath = sessionRoot === workspaceRoot ? `${SOURCE_REPOS_DIRNAME}/${name}` : name;
  return { agentHome: sessionRoot, singleRepoLocalPath };
}

function repoLocalPath(repo: GitRepo): string {
  return repo.localPath ?? deriveRepoLocalPath(repo.url);
}

type SessionManagerConfig = {
  session: SessionConfig;
  concurrency: number;
  /**
   * Optional process-tree probe. When present, an idle session whose provider
   * still has a live descendant (e.g. a `run_in_background` watcher) is not
   * idle-suspended and is deprioritized as a concurrency-eviction victim, up to
   * the `idle_timeout + working_grace_seconds` hard cap. Absent => behaviour is
   * exactly as before (no deferral). Wired by `agent-slot` per the
   * `session.defer_suspend_on_subprocess` config flag.
   */
  subprocessProbe?: SubprocessProbe;
  handlerFactory: HandlerFactory;
  handlerConfig: HandlerConfig;
  agentIdentity: AgentIdentity;
  sdk: FirstTreeHubSDK;
  log: pino.Logger;
  registryPath?: string;
  /** Step 4: optional config cache for refresh-before-dispatch on configVersion bump. */
  agentConfigCache?: AgentConfigCache;
  /** Stable file path updated on every runtime-session rebind for long-lived child CLI calls. */
  runtimeSessionTokenFile?: string;
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
   * `resolveAgentContextTreeBinding(sdk, workspaceRoot)` — pure config
   * resolution, no git; injected as a stub in tests to avoid the HTTP probe.
   */
  resolveContextTreeBinding?: () => Promise<ContextTreeBinding | null>;
  /** Callback when a session state changes (per-session granularity). */
  onStateChange?: (chatId: string, state: SessionState) => void;
  /** Callback when aggregated runtime state changes. */
  onRuntimeStateChange?: (state: RuntimeState) => void;
  /** Callback when a session emits a structured event (tool_call / error). */
  onSessionEvent?: (chatId: string, event: SessionEvent) => void;
  /** Confirmed session event channel; resolves only after the server persists the event. */
  confirmSessionEvent?: (chatId: string, event: SessionEvent) => Promise<void>;
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
const MAX_EAGER_IMAGE_FETCHES_PER_DELIVERY = MAX_MESSAGE_ATTACHMENT_REFS;

/**
 * Minimum spacing between lazy Context-Tree re-resolutions for a slot that is
 * currently tree-LESS. Caps the per-new-session HTTP probe for a
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

function normalizeStartReceipt(result: StartResult): {
  sessionId: string;
  route: Extract<HandlerRouteReceipt, { kind: "owned" }>;
} {
  if (typeof result === "string") {
    return { sessionId: result, route: { kind: "owned", mode: "queued" } };
  }
  return result;
}

function normalizeResumeReceipt(result: ResumeResult): {
  sessionId: string;
  route: Extract<HandlerRouteReceipt, { kind: "owned" }> | null;
} {
  if (typeof result === "string") {
    return { sessionId: result, route: { kind: "owned", mode: "queued" } };
  }
  return result;
}

function normalizeRouteReceipt(receipt: HandlerRouteReceipt | undefined): HandlerRouteReceipt {
  return receipt ?? { kind: "rejected", reason: "missing_route_receipt", retryable: true };
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
   * off the current or most-recent turn. The result-sink clears it at turn end.
   * It no longer drives an outbound reply: the per-turn final-text mirror is
   * retired, so `forwardResult` does not deliver anything (a human-visible reply
   * is a deliberate `chat send` / `chat ask` the agent issues). Maintained
   * entirely by the runtime: handlers never touch this map.
   */
  private readonly currentTrigger = new Map<string, Trigger>();
  private readonly registry: SessionRegistry | null;
  private readonly pendingQueue: PendingMessage[] = [];
  private readonly lastReportedStates = new Map<string, SessionState>();
  private readonly sessionRuntimeStates = new Map<string, RuntimeState>();
  /** Cache of chatId → organizationId, resolved via `getChatDetail`. A chat's
   *  org is immutable, so this is a cheap permanent memo that keeps doc-capture
   *  uploads off the hot path after the first lookup. */
  private readonly chatOrgIds = new Map<string, string>();
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

  updateTransport(sdk: FirstTreeHubSDK, agentConfigCache?: AgentConfigCache): void {
    this.config.sdk = sdk;
    if (agentConfigCache) {
      this.config.agentConfigCache = agentConfigCache;
    }
  }

  /**
   * Dispatch an inbox entry. ACK is deferred until the handler reports a
   * completed turn via `ctx.finishTurn(...)`.
   *
   * Delayed ACK semantics (post inflight-message-recovery): the entry stays
   * `delivered` server-side until the handler completes the turn via
   * `ctx.finishTurn(...)` (or surfaces a permanent error). If this client
   * crashes mid-turn, the next
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
    const suspending = this.sessions.get(chatId)?.suspending;
    if (suspending) await suspending;
    const isRecoveryRedelivery = this.inboxDelivery.takeRecoveryActivationReady(chatId);

    if (
      !isRecoveryRedelivery &&
      this.inboxDelivery.shouldRecoverBeforeDispatch(
        chatId,
        this.hasHealthyLiveHandler(chatId) || this.hasPendingTransientRetry(chatId),
        this.hasLocalRecoveryRisk(chatId),
      )
    ) {
      await this.inboxDelivery.recoverIfNeeded(chatId, `before_dispatch:${entry.id}:${messageId}`);
      return;
    }

    const decision = this.inboxDelivery.receive(entry);
    if (decision.kind !== "deliver") return;
    const { work } = decision;
    const message = this.extractMessage(entry);

    let routePromise: Promise<void> | undefined;
    try {
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

        // 4b. Preserve current-message image materialization, then pull only
        // generic request images from silent preceding context. The added
        // history work is best-effort and bounded; anything not fetched still
        // renders with a filename and an unavailable placeholder.
        await this.ensureImagesLocal(message);

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
        const deliveryKind: SlotDeliveryKind = isRecoveryRedelivery ? "recovery" : "fresh";
        routePromise = this.routeMessage(chatId, message, deliveryKind).catch((err) => {
          if (this.inboxDelivery.hasEntry(work)) {
            this.retryDeliveryTurn(chatId, message, "route_message_failed");
          }
          throw err;
        });
      });
    } catch (err) {
      if (this.inboxDelivery.hasEntry(work)) {
        this.retryDeliveryTurn(chatId, message, "admission_failed");
      }
      throw err;
    }

    if (routePromise) await routePromise;
  }

  /**
   * Resolve current-message image refs exactly as before, then materialize only
   * the generic request-image refs from silent preceding context. Historical
   * refs are considered newest-first under a separate 10-fetch budget;
   * duplicates and cached refs consume no budget.
   */
  private async ensureImagesLocal(message: SessionMessage): Promise<void> {
    const legacyImageRefs =
      message.format === "file" && isImageBatchRefContent(message.content)
        ? message.content.attachments
        : message.format === "file" && isImageRefContent(message.content)
          ? [message.content]
          : [];
    const genericImageRefs = imageAttachmentRefsFromMetadata(message.metadata ?? undefined).map((ref) => ({
      imageId: ref.attachmentId,
      mimeType: ref.mimeType,
      filename: ref.filename,
      size: ref.size,
    }));
    const imageRefs = [...legacyImageRefs, ...genericImageRefs];
    const seenImageIds = new Set(imageRefs.map((ref) => ref.imageId));
    let precedingFetches = 0;
    for (const source of (message.precedingMessages ?? []).slice().reverse()) {
      if (source.format !== "request") continue;
      for (const ref of imageAttachmentRefsFromMetadata(source.metadata ?? undefined)) {
        if (seenImageIds.has(ref.attachmentId)) continue;
        seenImageIds.add(ref.attachmentId);
        if (findImagePath(message.chatId, ref.attachmentId, ref.mimeType)) continue;
        if (precedingFetches === MAX_EAGER_IMAGE_FETCHES_PER_DELIVERY) break;
        imageRefs.push({
          imageId: ref.attachmentId,
          mimeType: ref.mimeType,
          filename: ref.filename,
          size: ref.size,
        });
        precedingFetches += 1;
      }
      if (precedingFetches === MAX_EAGER_IMAGE_FETCHES_PER_DELIVERY) break;
    }
    await Promise.all(
      imageRefs.map(async (ref) => {
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

    // Documents/files: generic refs in `metadata.attachments`, any format.
    // Written under the files dir keyed by their real filename so the handler
    // can hand the model an on-disk path to Read. A no-op for messages without
    // document attachments (the common case).
    const docRefs = attachmentRefsFromMetadata(message.metadata ?? undefined).filter((ref) => ref.kind !== "image");
    await Promise.all(
      docRefs.map(async (ref) => {
        if (findAttachmentFile(message.chatId, ref.attachmentId, ref.filename)) return;
        try {
          const { bytes } = await this.config.sdk.fetchAttachment({ id: ref.attachmentId });
          await writeAttachmentFile({
            chatId: message.chatId,
            attachmentId: ref.attachmentId,
            filename: ref.filename,
            base64: bytes.toString("base64"),
          });
        } catch (err) {
          this.config.log.warn(
            { chatId: message.chatId, attachmentId: ref.attachmentId, err },
            "eager attachment fetch failed — agent will not see this file",
          );
        }
      }),
    );
  }

  /** Handle a server-issued session command. Terminate drops all local state without reporting back. */
  async handleCommand(chatId: string, command: SessionCommandType): Promise<void> {
    if (command === "session:suspend") {
      const session = this.sessions.get(chatId);
      if (session) this.clearRetryState(session);
      if (session?.status === "active") {
        this.config.log.info({ chatId }, "suspend command received");
        this.suspendSession(session, {
          reason: "operator_suspended",
          ackConsumedPrefix: true,
          operatorResolution: true,
        });
      } else {
        await this.inboxDelivery.prepareOperatorSuspend(chatId);
      }
      this.projectSessionRuntime(chatId);
      return;
    }

    if (command === "session:resume") {
      const session = this.sessions.get(chatId);
      if (session?.suspending) await session.suspending;
      if (await this.recoverDebtBeforeResume(chatId, "session_resume:recovery_debt")) {
        this.drainPendingQueue();
        return;
      }
      const current = this.sessions.get(chatId);
      if (current && current.status !== "active") {
        this.config.log.info({ chatId }, "resume command received");
        await this.resumeSession(current, undefined, "fresh");
      }
      this.projectSessionRuntime(chatId);
      this.drainPendingQueue();
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

  /** Chat IDs this client still holds locally and should report to runtime sync. */
  getHeldChatIds(activeChatIds: RuntimeSyncActiveSet = null): string[] {
    const ids = new Set<string>();
    for (const id of this.sessions.keys()) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    for (const id of this.evictedMappings.keys()) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
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
  async shutdown(reason?: string, opts: SessionManagerShutdownOptions = {}): Promise<void> {
    this.config.subprocessProbe?.stop();
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
      s.status === "active" ? s.handler.shutdown(reason) : Promise.resolve(),
    );
    await Promise.allSettled(shutdowns);

    const reportSuspendedSessions = opts.reportSuspendedSessions ?? true;
    if (reportSuspendedSessions) {
      // Report active sessions as suspended before clearing.
      for (const [chatId, session] of this.sessions) {
        if (session.status === "active") {
          this.notifySessionState(chatId, "suspended");
        }
      }
    }

    if (opts.clearPersistedRegistry) {
      this.sessions.clear();
      this.evictedMappings.clear();
    }

    // Persist final state — flush synchronously so the last batch reaches
    // disk before dispose() tears the timer down. For destructive runtime
    // switches, the cleared maps make this an authoritative empty registry.
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
  getSessionStates(activeChatIds: RuntimeSyncActiveSet = null): Array<{ chatId: string; state: SessionState }> {
    return [...this.sessions.entries()]
      .filter(([chatId]) => this.shouldIncludeInRuntimeSync(chatId, activeChatIds))
      .map(([chatId, entry]) => ({
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
  getEvictedChatIds(activeChatIds: RuntimeSyncActiveSet = null): string[] {
    return [...this.evictedMappings.keys()].filter((chatId) => this.shouldIncludeInRuntimeSync(chatId, activeChatIds));
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

  private hasLocalRecoveryRisk(chatId: string): boolean {
    return this.evictedMappings.has(chatId) || this.sessions.get(chatId)?.status === "evicted";
  }

  private shouldIncludeInRuntimeSync(chatId: string, activeChatIds: RuntimeSyncActiveSet): boolean {
    if (activeChatIds === null) return true;
    if (activeChatIds.has(chatId)) return true;
    return this.hasRuntimeSyncForceKeep(chatId);
  }

  private hasRuntimeSyncForceKeep(chatId: string): boolean {
    if (this.pendingQueue.some((queued) => queued.chatId === chatId)) return true;
    if (this.hasPendingTransientRetry(chatId)) return true;
    return this.inboxDelivery.hasUnsettledWork(chatId);
  }

  private clearRetryState(entry: SessionEntry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryAttempt = 0;
    entry.retryNextAt = null;
    entry.retryTimer = null;
    entry.lastRetryReason = null;
    entry.lastRetryCategory = null;
    entry.lastRetryScope = null;
    entry.lastRetryRawError = null;
    entry.retryQueuedMessages = [];
  }

  private runtimeProvider(): RuntimeProvider {
    const parsed = runtimeProviderSchema.safeParse(this.config.handlerConfig.runtimeProvider);
    return parsed.success ? parsed.data : "claude-code";
  }

  private captureRuntimeFailureNotice(chatId: string, event: SessionEvent): void {
    if (event.kind !== "error") return;
    const payload = parseProviderRetryEventMessage(event.payload.message);
    if (!payload || !shouldPostProviderFailureRuntimeNotice(payload)) return;

    const entry = this.sessions.get(chatId);
    if (!entry) return;
    entry.pendingRuntimeFailureNotice = payload;
  }

  private clearPendingRuntimeFailureNotice(chatId: string): void {
    const entry = this.sessions.get(chatId);
    if (entry) entry.pendingRuntimeFailureNotice = null;
  }

  private retryDeliveryTurn(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reason: string,
  ): void {
    this.clearPendingRuntimeFailureNotice(chatId);
    this.inboxDelivery.retryTurn(chatId, messages, reason);
  }

  private emitRuntimeFailureNoticeDeliveryFailure(chatId: string, err: unknown): void {
    try {
      this.config.onSessionEvent?.(chatId, {
        kind: "error",
        payload: {
          source: "runtime",
          message: `runtime failure notice delivery failed: ${err instanceof Error ? err.message : String(err)}`,
        },
      });
    } catch (emitErr) {
      this.config.log.warn({ chatId, emitErr }, "runtime failure notice delivery error event emit failed");
    }
  }

  private async postPendingRuntimeFailureNotice(chatId: string): Promise<boolean> {
    const entry = this.sessions.get(chatId);
    const payload = entry?.pendingRuntimeFailureNotice;
    if (!entry || !payload) return true;

    try {
      await postProviderFailureRuntimeNotice(this.config.sdk, chatId, payload);
      entry.pendingRuntimeFailureNotice = null;
      return true;
    } catch (err) {
      this.config.log.warn({ chatId, err, reasonCode: payload.reasonCode }, "runtime failure notice delivery failed");
      this.emitRuntimeFailureNoticeDeliveryFailure(chatId, err);
      return false;
    }
  }

  private retryClassificationForEntry(entry: SessionEntry): ProviderFailureClassification {
    return {
      category: entry.lastRetryCategory ?? "unknown",
      reasonCode: entry.lastRetryReason ?? "unknown",
      message: entry.lastRetryRawError ?? entry.lastRetryReason ?? "unknown",
      sourceKind: "transient",
    };
  }

  private async recoverDebtBeforeResume(chatId: string, reason: string): Promise<boolean> {
    if (!this.inboxDelivery.hasRecoveryDebt(chatId)) return false;
    this.config.log.info({ chatId, reason }, "resume deferred because chat has recovery debt");
    await this.inboxDelivery.recoverIfNeeded(chatId, reason);
    this.projectSessionRuntime(chatId);
    return true;
  }

  private failSessionForRecovery(chatId: string, reason: string, sessionId?: string): void {
    const entry = this.sessions.get(chatId);
    if (!entry) return;

    this.clearRetryState(entry);
    const resumeSessionId = sessionId || entry.claudeSessionId || entry.retryFromEvicted?.claudeSessionId || "";
    if (resumeSessionId) {
      this.addEvictedMapping(chatId, {
        claudeSessionId: resumeSessionId,
        lastActivity: entry.lastActivity,
      });
    }
    if (entry.status === "active") {
      this._activeCount = Math.max(0, this._activeCount - 1);
    }

    this.inboxDelivery.prepareEvict(chatId, reason);
    this.sessions.delete(chatId);
    this.sessionRuntimeStates.delete(chatId);
    this.currentTrigger.delete(chatId);
    this.notifySessionState(chatId, "errored");
    this.config.log.warn({ chatId, reason }, "session failed locally; recovery will use a fresh handler");
    this.recomputeRuntimeState();
    this.persistRegistry();
    this.drainPendingQueue();
  }

  private abortUnownedRoute(entry: SessionEntry, reason: string): void {
    const { chatId } = entry;
    if (this.sessions.get(chatId) !== entry) return;
    this.config.log.warn({ chatId, reason }, "handler route completed after inbox custody was cleared");
    if (entry.status === "active") this._activeCount = Math.max(0, this._activeCount - 1);
    void entry.handler.shutdown(reason).catch((err) => {
      this.config.log.warn({ chatId, reason, err }, "failed to shut down unowned handler route");
    });
    this.sessions.delete(chatId);
    this.sessionRuntimeStates.delete(chatId);
    this.currentTrigger.delete(chatId);
    this.recomputeRuntimeState();
    this.persistRegistry();
    this.drainPendingQueue();
  }

  private errorCompletionRetryReason(outcome: TurnOutcome): string | null {
    if (outcome.status === "success") return null;
    if (outcome.completion === "consumed") return null;
    if (outcome.errorKind === "deterministic") return "complete_requires_terminal_rejected";
    if (outcome.errorKind === "transient") return "complete_transient_error_requires_retry";
    if (outcome.errorKind === "unknown") return "complete_unknown_error_requires_retry";
    return "complete_error_missing_classification";
  }

  private warnRejectedErrorCompletion(chatId: string, outcome: TurnOutcome, reason: string): void {
    if (outcome.status !== "error") return;
    this.config.log.warn(
      {
        chatId,
        errorKind: outcome.errorKind,
        completion: outcome.completion,
        reason,
      },
      "delivery error completion is not ACK-eligible; retrying instead",
    );
  }

  private async completeDeliveryTurn(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    outcome: TurnOutcome,
  ): Promise<void> {
    const retryReason = this.errorCompletionRetryReason(outcome);
    if (retryReason) {
      this.warnRejectedErrorCompletion(chatId, outcome, retryReason);
      this.retryDeliveryTurn(chatId, messages, retryReason);
      this.projectSessionRuntime(chatId);
      return;
    }
    if (outcome.status === "success") {
      this.clearPendingRuntimeFailureNotice(chatId);
    } else if (outcome.completion === "consumed") {
      const noticePosted = await this.postPendingRuntimeFailureNotice(chatId);
      if (!noticePosted) {
        this.retryDeliveryTurn(chatId, messages, "runtime_failure_notice_delivery_failed");
        this.projectSessionRuntime(chatId);
        return;
      }
    }
    await this.inboxDelivery.finishTurn(chatId, messages, outcome);
    this.projectSessionRuntime(chatId);
  }

  private createDeliveryToken(chatId: string): DeliveryToken {
    let terminalReported = false;
    const claimTerminal = (action: string): boolean => {
      if (!terminalReported) {
        terminalReported = true;
        return true;
      }
      this.config.log.warn({ chatId, action }, "delivery token terminal outcome ignored after prior outcome");
      return false;
    };
    return {
      processingStarted: (messages) => {
        if (terminalReported) return;
        this.inboxDelivery.markProcessingStarted(chatId, messages);
        this.projectSessionRuntime(chatId);
      },
      complete: async (messages, outcome) => {
        if (!claimTerminal("complete")) return;
        await this.completeDeliveryTurn(chatId, messages, outcome);
      },
      retry: (messages, reason) => {
        if (!claimTerminal("retry")) return;
        this.retryDeliveryTurn(chatId, messages, reason);
        this.projectSessionRuntime(chatId);
      },
      terminalRejected: async (messages, reason, evidence) => {
        if (!claimTerminal("terminalRejected")) return;
        const noticePosted = await this.postPendingRuntimeFailureNotice(chatId);
        if (!noticePosted) {
          this.retryDeliveryTurn(chatId, messages, "runtime_failure_notice_delivery_failed");
          this.projectSessionRuntime(chatId);
          return;
        }
        await this.inboxDelivery.terminalRejected(chatId, messages, reason, evidence);
        this.projectSessionRuntime(chatId);
      },
    };
  }

  private markRouteOwned(
    chatId: string,
    message: SessionMessage,
    receipt: HandlerRouteReceipt,
  ): DeliveryRouteOwnership {
    if (receipt.kind === "rejected") {
      this.config.log.warn(
        { chatId, messageId: message.id, entryId: message.inboxEntryId, reason: receipt.reason },
        "handler rejected inbox delivery before custody",
      );
      this.retryDeliveryTurn(chatId, message, `handler_rejected:${receipt.reason}`);
      return "lost";
    }
    if (message.inboxEntryId === undefined) return "owned";
    const ownership = this.inboxDelivery.markOwned({ chatId, messageId: message.id, entryId: message.inboxEntryId });
    if (ownership === "owned" && receipt.mode === "processing") {
      this.inboxDelivery.markProcessingStarted(chatId, message);
    }
    this.projectSessionRuntime(chatId);
    return ownership;
  }

  private async routeMessage(
    chatId: string,
    message: SessionMessage,
    deliveryKind: SlotDeliveryKind = "fresh",
  ): Promise<void> {
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
          if (
            this.markRouteOwned(
              chatId,
              message,
              normalizeRouteReceipt(existing.handler.inject(message, this.createDeliveryToken(chatId))),
            ) === "lost"
          ) {
            return;
          }
          existing.lastActivity = Date.now();
          this.projectSessionRuntime(chatId);
          this.config.log.debug({ chatId }, "message injected");
          return;

        case "suspended":
        case "evicted":
          await this.resumeSession(existing, message, deliveryKind);
          return;

        case "errored":
          this.queueForSlot(chatId, message, deliveryKind, "terminal_teardown_pending");
          return;
      }
    }

    // No existing session — create new
    await this.startNewSession(chatId, message, deliveryKind);
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
    // common case) doesn't fire an HTTP GET on EVERY new session for the
    // slot's whole life. A tree configured later is still picked up within
    // TREE_RERESOLVE_INTERVAL_MS on the next new session.
    const now = Date.now();
    if (now - this.lastTreeResolveAttemptAt < TREE_RERESOLVE_INTERVAL_MS) return;
    this.lastTreeResolveAttemptAt = now;

    const resolve =
      this.config.resolveContextTreeBinding ??
      (() =>
        resolveAgentContextTreeBinding(this.config.sdk, this.config.handlerConfig.workspaceRoot, (msg) =>
          this.config.log.info(msg),
        ));
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

  private async startNewSession(
    chatId: string,
    message: SessionMessage,
    deliveryKind: SlotDeliveryKind,
  ): Promise<void> {
    // Enforce max_sessions before active-slot preemption so a full pool of
    // working sessions queues instead of first suspending a working victim.
    if (!this.evictIfNeeded(chatId, message, deliveryKind)) return;

    // Enforce concurrency limit
    if (!this.acquireActiveSlot(chatId, message, deliveryKind)) return;

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
      lastRetryCategory: null,
      lastRetryScope: null,
      lastRetryRawError: null,
      startMessage: message,
      retryQueuedMessages: [],
      pendingRuntimeFailureNotice: null,
      retryFromEvicted: evicted ?? null,
    };

    this.sessions.set(chatId, entry);
    this._activeCount++;
    if (evicted) this.evictedMappings.delete(chatId);

    // Report `active` before runtime projection. `session:runtime` frames are
    // active-gated on the server, so the state row must exist before a fresh
    // delivery projects this chat to working.
    this.notifySessionState(chatId, "active");
    this.projectSessionRuntime(chatId, { drainPendingOnIdle: false });
    try {
      this.setCurrentTrigger(chatId, message);
      const token = this.createDeliveryToken(chatId);
      if (evicted) {
        const receipt = normalizeResumeReceipt(await handler.resume(message, evicted.claudeSessionId, ctx, token));
        if (this.sessions.get(chatId) !== entry) return;
        entry.claudeSessionId = receipt.sessionId;
        if (receipt.route) {
          const ownership = this.markRouteOwned(chatId, message, receipt.route);
          if (ownership === "lost") {
            this.abortUnownedRoute(entry, "session_eviction_resume_unowned_delivery");
            return;
          }
        }
        this.config.log.info({ chatId, sessionId: entry.claudeSessionId }, "session resumed from eviction");
      } else {
        const receipt = normalizeStartReceipt(await handler.start(message, ctx, token));
        if (this.sessions.get(chatId) !== entry) return;
        entry.claudeSessionId = receipt.sessionId;
        if (this.markRouteOwned(chatId, message, receipt.route) === "lost") {
          this.abortUnownedRoute(entry, "session_start_unowned_delivery");
          return;
        }
        this.config.log.info({ chatId, sessionId: entry.claudeSessionId }, "session created");
      }
      this.persistRegistry();
    } catch (err) {
      if (this.sessions.get(chatId) !== entry) return;
      const phase: "start" | "resume" = evicted ? "resume" : "start";
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: phase === "start" ? "session_start" : "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        ctx,
        err,
        phase,
        classification,
      });
      if (this.sessions.get(chatId) !== entry) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, message, handling);
    }
  }

  private async resumeSession(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    deliveryKind: SlotDeliveryKind = "fresh",
  ): Promise<void> {
    // Wait for in-flight suspension to complete before resuming
    if (entry.suspending) {
      await entry.suspending;
    }
    if (await this.recoverDebtBeforeResume(entry.chatId, "session_resume:recovery_debt")) return;

    // Admin-triggered resume has no provider input. It may use idle capacity,
    // but it must not preempt unrelated working turns.
    const slotKind: SlotDeliveryKind = message ? deliveryKind : "control";
    if (!this.acquireActiveSlot(entry.chatId, message ?? null, slotKind)) return;

    const ctx = this.buildSessionContext(entry.chatId);
    entry.status = "active";
    this._activeCount++;
    entry.lastActivity = Date.now();

    this.notifySessionState(entry.chatId, "active");
    this.projectSessionRuntime(entry.chatId, { drainPendingOnIdle: false });
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
      const token = message ? this.createDeliveryToken(entry.chatId) : undefined;
      const resumeResult = token
        ? await entry.handler.resume(message ?? undefined, entry.claudeSessionId, ctx, token)
        : await entry.handler.resume(message ?? undefined, entry.claudeSessionId, ctx);
      if (this.sessions.get(entry.chatId) !== entry) return;
      const receipt = normalizeResumeReceipt(resumeResult);
      entry.claudeSessionId = receipt.sessionId;
      if (message && receipt.route) {
        const ownership = this.markRouteOwned(entry.chatId, message, receipt.route);
        if (ownership === "lost") {
          this.abortUnownedRoute(entry, "session_resume_unowned_delivery");
          return;
        }
      }
      this.config.log.info({ chatId: entry.chatId, sessionId: entry.claudeSessionId }, "session resumed");
      this.persistRegistry();
    } catch (err) {
      if (this.sessions.get(entry.chatId) !== entry) return;
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        ctx,
        err,
        phase: "resume",
        classification,
      });
      if (this.sessions.get(entry.chatId) !== entry) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, message ?? null, handling);
    }
  }

  /**
   * Decide what to do when handler.start / handler.resume rejects. Returns
   * a retry disposition when the entry was kept with a timer armed, or a
   * terminal disposition when the caller should run permanent-failure
   * teardown. The terminal disposition also records whether the chat-visible
   * error event was emitted successfully; only that case is ACK-eligible.
   *
   * Bug 1 fix (client-resilience-design §5.1): transient errors keep the
   * entry around with an exponential-backoff retry. Permanent / degraded
   * errors fall through to the legacy F2 teardown path.
   */
  private async handleSessionFailure(args: {
    entry: SessionEntry;
    ctx: SessionContext;
    err: unknown;
    phase: "start" | "resume";
    classification: ProviderFailureClassification;
  }): Promise<SessionFailureHandling> {
    const { entry, ctx, err, phase, classification } = args;
    const errMsg = err instanceof Error ? err.message : String(err);
    const chatId = entry.chatId;
    const provider = this.runtimeProvider();
    const scope = phase === "start" ? "session_start" : "session_resume";
    const nextAttempt = clampRetryAttempt(entry.retryAttempt + 1);
    const decision = decideProviderRetry({
      classification,
      scope,
      attempt: nextAttempt,
      replaySafety: "pre_provider",
    });

    this.config.log.error(
      { chatId, err, phase, category: classification.category, reasonCode: classification.reasonCode },
      "session start/resume failed",
    );

    if (decision.action === "retry") {
      entry.retryAttempt = decision.attempt;
      entry.lastRetryReason = decision.reasonCode;
      entry.lastRetryCategory = classification.category;
      entry.lastRetryScope = scope;
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
      const delayMs = decision.delayMs;
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
          reasonCode: decision.reasonCode,
          category: classification.category,
          phase,
          resilienceEvent: "provider_retry_scheduled",
        },
        "session transient failure — scheduling retry",
      );
      // Design §6.1: also emit through the SessionContext.emitEvent channel
      // so future server-side consumers see the signal. The closed kind-union
      // (sessionEventSchema) can't hold "resilience.session.retry_scheduled"
      // directly, so we encode it as a structured `error` event with the
      // resilience tag in the message prefix — see ResiliencePayload helper.
      try {
        const payload = buildProviderRetryEvent({
          event: "provider_retry_scheduled",
          provider,
          scope,
          classification,
          decision,
          messagePreview: errMsg,
        });
        ctx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: encodeProviderRetryEventMessage(payload),
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
      return { kind: "retry" };
    }

    // Stop decision — legacy F2 teardown still owns ACK/recovery, but the
    // visible signal is now the standard provider retry payload.
    entry.status = "errored";
    this.notifySessionState(chatId, "errored");
    this.projectSessionRuntime(chatId);
    // Same `safe in logs but NOT chat` boundary as the transient `rawError`
    // path above: the error message can legitimately echo back a git remote
    // URL with embedded credentials or a token-bearing SDK request, and this
    // event is rendered into chat-visible UI. Redact before slicing — slicing
    // first risks leaving a partial-token tail across the truncation point.
    const preview = redactErrorPreview(errMsg, 800);
    const payload = buildProviderRetryEvent({
      event: decision.terminalKind === "exhausted" ? "provider_retry_exhausted" : "provider_failure_terminal",
      provider,
      scope,
      classification,
      decision,
      messagePreview: preview,
    });
    const terminalEventPersisted = await this.emitConfirmedSessionEvent(chatId, {
      kind: "error",
      payload: {
        source: "runtime",
        message: encodeProviderRetryEventMessage(payload),
      },
    });
    return { kind: "terminal", reasonCode: decision.reasonCode, terminalEventPersisted };
  }

  private async emitConfirmedSessionEvent(chatId: string, event: SessionEvent): Promise<boolean> {
    if (this.config.confirmSessionEvent) {
      try {
        await this.config.confirmSessionEvent(chatId, event);
        this.captureRuntimeFailureNotice(chatId, event);
        return true;
      } catch (emitErr) {
        this.config.log.warn({ chatId, emitErr }, "confirmed session event emit failed");
        return false;
      }
    }
    try {
      this.config.onSessionEvent?.(chatId, event);
      this.captureRuntimeFailureNotice(chatId, event);
    } catch (emitErr) {
      this.config.log.warn({ chatId, emitErr }, "session error event emit failed");
    }
    return false;
  }

  private async teardownTerminalSessionFailure(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    handling: Extract<SessionFailureHandling, { kind: "terminal" }>,
  ): Promise<void> {
    const chatId = entry.chatId;
    if (this.sessions.get(chatId) !== entry) return;
    if (handling.terminalEventPersisted && message) {
      await this.completeDeliveryTurn(chatId, message, {
        status: "error",
        terminal: true,
        completion: "consumed",
        reason: `session_failure_terminal:${handling.reasonCode}`,
      });
    } else {
      await this.inboxDelivery.drainForTerminate(chatId);
    }

    if (this.sessions.get(chatId) !== entry) return;
    this.sessions.delete(chatId);
    this.sessionRuntimeStates.delete(chatId);
    this.currentTrigger.delete(chatId);
    this.recomputeRuntimeState();
    this._activeCount = Math.max(0, this._activeCount - 1);
    this.drainPendingQueue();
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
    if (this.inboxDelivery.hasRecoveryDebt(chatId)) {
      this.clearRetryState(entry);
      await this.inboxDelivery.recoverIfNeeded(chatId, "session_retry:recovery_debt");
      this.projectSessionRuntime(chatId);
      return;
    }

    this.config.log.info(
      {
        chatId,
        attempt: entry.retryAttempt,
        reasonCode: entry.lastRetryReason,
        category: entry.lastRetryCategory,
        resilienceEvent: "provider_retry_started",
      },
      "session transient retry — starting attempt",
    );
    // Design §6.1: emit via SessionContext.emitEvent (post-slot-acquire we
    // build the real ctx; here we use a lightweight onSessionEvent path).
    try {
      const scope = entry.lastRetryScope ?? (previousAvailable(entry) ? "session_resume" : "session_start");
      const classification = this.retryClassificationForEntry(entry);
      this.config.onSessionEvent?.(chatId, {
        kind: "error",
        payload: {
          source: "runtime",
          message: encodeProviderRetryEventMessage(
            buildProviderRetryEvent({
              event: "provider_retry_started",
              provider: this.runtimeProvider(),
              scope,
              classification,
              messagePreview: entry.lastRetryRawError,
            }),
          ),
        },
      });
    } catch (emitErr) {
      this.config.log.warn({ chatId, emitErr }, "resilience retry_started emit failed");
    }

    // Enforce concurrency limit before claiming the slot. If we cannot, the
    // entry stays in transient-retry state and a future retry / message will
    // try again.
    if (!this.acquireActiveSlot(chatId, entry.startMessage ?? buildEmptySessionMessage(chatId), "recovery")) {
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
    this.projectSessionRuntime(chatId, { drainPendingOnIdle: false });
    try {
      const resumeMessage = entry.startMessage ?? null;
      const previousSessionId = entry.claudeSessionId || entry.retryFromEvicted?.claudeSessionId || "";
      if (resumeMessage) this.setCurrentTrigger(chatId, resumeMessage);
      const token = resumeMessage ? this.createDeliveryToken(chatId) : undefined;
      if (previousSessionId) {
        const resumeResult = token
          ? await newHandler.resume(resumeMessage ?? undefined, previousSessionId, ctx, token)
          : await newHandler.resume(resumeMessage ?? undefined, previousSessionId, ctx);
        if (this.sessions.get(chatId) !== entry) return;
        const receipt = normalizeResumeReceipt(resumeResult);
        entry.claudeSessionId = receipt.sessionId;
        if (resumeMessage && receipt.route) {
          const ownership = this.markRouteOwned(chatId, resumeMessage, receipt.route);
          if (ownership === "lost") {
            this.abortUnownedRoute(entry, "session_retry_resume_unowned_delivery");
            return;
          }
        }
      } else {
        // No resume key yet — fall back to fresh start.
        const message = resumeMessage ?? buildEmptySessionMessage(chatId);
        const receipt = normalizeStartReceipt(await newHandler.start(message, ctx, this.createDeliveryToken(chatId)));
        if (this.sessions.get(chatId) !== entry) return;
        entry.claudeSessionId = receipt.sessionId;
        if (this.markRouteOwned(chatId, message, receipt.route) === "lost") {
          this.abortUnownedRoute(entry, "session_retry_start_unowned_delivery");
          return;
        }
      }
      const totalAttempts = entry.retryAttempt;
      const succeededScope = entry.lastRetryScope ?? (previousAvailable(entry) ? "session_resume" : "session_start");
      const succeededClassification = this.retryClassificationForEntry(entry);
      entry.retryAttempt = 0;
      entry.retryNextAt = null;
      entry.lastRetryReason = null;
      entry.lastRetryCategory = null;
      entry.lastRetryScope = null;
      entry.lastRetryRawError = null;
      this.config.log.info(
        {
          chatId,
          sessionId: entry.claudeSessionId,
          resilienceEvent: "provider_retry_succeeded",
        },
        "session transient retry succeeded",
      );
      try {
        ctx.emitEvent({
          kind: "error",
          payload: {
            source: "runtime",
            message: encodeProviderRetryEventMessage(
              buildProviderRetryEvent({
                event: "provider_retry_succeeded",
                provider: this.runtimeProvider(),
                scope: succeededScope,
                classification: succeededClassification,
                messagePreview: `retry succeeded after ${totalAttempts} attempt(s)`,
              }),
            ),
          },
        });
      } catch (emitErr) {
        this.config.log.warn({ chatId, emitErr }, "resilience retry_succeeded emit failed");
      }
      this.drainRetryQueuedMessages(entry);
      this.persistRegistry();
    } catch (err) {
      if (this.sessions.get(chatId) !== entry) return;
      const phase = previousAvailable(entry) ? "resume" : "start";
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: phase === "start" ? "session_start" : "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        ctx,
        err,
        phase,
        classification,
      });
      if (this.sessions.get(chatId) !== entry) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, entry.startMessage, handling);
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
        if (
          this.markRouteOwned(
            entry.chatId,
            message,
            normalizeRouteReceipt(entry.handler.inject(message, this.createDeliveryToken(entry.chatId))),
          ) === "lost"
        ) {
          continue;
        }
        entry.lastActivity = Date.now();
      } catch (err) {
        this.config.log.warn({ chatId: entry.chatId, messageId: message.id, err }, "retry queued inject failed");
        this.retryDeliveryTurn(entry.chatId, message, "retry_queued_inject_failed");
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
   * 1. Suspend the least-recently-active idle session to free a slot.
   * 2. For fresh external input only, preempt the least-recently-active
   *    working session as a last resort and force recovery for its work.
   * 3. Queue recovery/internal traffic instead of displacing working sessions.
   *
   * Returns true if slot acquired, false if queued. The in-flight entryId
   * is tracked separately in `InboxDeliveryCoordinator` (populated at dispatch),
   * so the queue doesn't carry inbox metadata.
   */
  private acquireActiveSlot(
    chatId: string,
    message: SessionMessage | null,
    deliveryKind: SlotDeliveryKind = "fresh",
  ): boolean {
    if (this._activeCount < this.config.concurrency) return true;

    // Pick a victim, preferring (a) idle over working, and (b) within each
    // tier, sessions with no live background subprocess. A `run_in_background`
    // watcher cannot be recovered once its session is torn down, so a session
    // that has one is the worst thing to sacrifice — but it is still a valid
    // last-resort victim (the evictIdle hard cap bounds how long it could hold
    // the slot anyway), so we fall back to allowing it rather than starve the
    // requester. `protectSubprocess=false` is that fallback pass.
    const choose = (protectSubprocess: boolean): { victim: SessionEntry; kind: "idle" | "working" } | null => {
      const idle = this.findOldestActiveSession(
        (session) =>
          session.chatId !== chatId &&
          !this.inboxDelivery.hasProcessingOwnedWork(session.chatId) &&
          (!protectSubprocess || !this.hasLiveSubprocess(session.chatId)),
      );
      if (idle) return { victim: idle, kind: "idle" };
      if (deliveryKind === "fresh") {
        const working = this.findOldestActiveSession(
          (session) => session.chatId !== chatId && (!protectSubprocess || !this.hasLiveSubprocess(session.chatId)),
        );
        if (working) return { victim: working, kind: "working" };
      }
      return null;
    };

    const chosen = choose(true) ?? choose(false);

    if (chosen?.kind === "idle") {
      this.config.log.info(
        { chatId: chosen.victim.chatId, requesterChatId: chatId },
        "idle session yielded for concurrency",
      );
      this.suspendSession(chosen.victim, {
        reason: "concurrency_idle_yield",
        ackConsumedPrefix: true,
        drainQueue: false,
      });
      return true;
    }

    if (chosen?.kind === "working") {
      this.config.log.info(
        { chatId: chosen.victim.chatId, requesterChatId: chatId },
        "working session preempted for fresh input",
      );
      this.emitResilienceEvent(chosen.victim.chatId, "resilience.session.preempted", {
        reason: "concurrency_preempted",
        requesterChatId: chatId,
      });
      this.suspendSession(chosen.victim, {
        reason: "concurrency_preempted",
        ackConsumedPrefix: false,
        drainQueue: false,
      });
      return true;
    }

    this.queueForSlot(chatId, message, deliveryKind, "concurrency_limit");
    return false;
  }

  /**
   * Whether the session's provider currently has a live background subprocess,
   * per the optional {@link SubprocessProbe}. Absent probe => always false, so
   * suspend/eviction behave exactly as before the probe was introduced.
   */
  private hasLiveSubprocess(chatId: string): boolean {
    return this.config.subprocessProbe?.hasLiveSubprocess(chatId) === true;
  }

  private findOldestActiveSession(eligible: (session: SessionEntry) => boolean): SessionEntry | null {
    let oldest: SessionEntry | null = null;
    for (const session of this.sessions.values()) {
      if (session.status !== "active") continue;
      if (!eligible(session)) continue;
      if (!oldest || session.lastActivity < oldest.lastActivity) oldest = session;
    }
    return oldest;
  }

  private queueForSlot(
    chatId: string,
    message: SessionMessage | null,
    deliveryKind: SlotDeliveryKind,
    reason: "concurrency_limit" | "max_sessions_all_working" | "terminal_teardown_pending",
  ): void {
    this.config.log.info({ chatId, deliveryKind, reason }, "session slot unavailable, queuing");
    this.emitResilienceEvent(chatId, "resilience.session.queued", { reason, deliveryKind });
    this.pendingQueue.push({ message, chatId, deliveryKind });
  }

  private queuedMessageStillOwned(queued: PendingMessage): boolean {
    const { message, chatId } = queued;
    if (!message || message.inboxEntryId === undefined) return true;
    return this.inboxDelivery.hasEntry({ chatId, messageId: message.id, entryId: message.inboxEntryId });
  }

  private emitResilienceEvent(chatId: string, eventName: string, payload: Record<string, unknown>): void {
    try {
      this.config.onSessionEvent?.(chatId, {
        kind: "error",
        payload: {
          source: "runtime",
          message: encodeResilienceMessage(eventName, payload),
        },
      });
    } catch (err) {
      this.config.log.warn({ chatId, eventName, err }, "resilience event emit failed");
    }
  }

  private suspendSession(
    entry: SessionEntry,
    opts: { reason: string; ackConsumedPrefix: boolean; drainQueue?: boolean; operatorResolution?: boolean } = {
      reason: "session_suspended",
      ackConsumedPrefix: true,
      drainQueue: true,
    },
  ): void {
    const prepare = opts.operatorResolution
      ? this.inboxDelivery.prepareOperatorSuspend(entry.chatId)
      : opts.ackConsumedPrefix
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

    if (opts.drainQueue !== false) this.drainPendingQueue();
  }

  private drainPendingQueue(): void {
    if (this.pendingQueue.length === 0) return;
    for (let index = this.pendingQueue.length - 1; index >= 0; index--) {
      const queued = this.pendingQueue[index];
      if (!queued || this.queuedMessageStillOwned(queued)) continue;
      this.config.log.info(
        { chatId: queued.chatId, messageId: queued.message?.id, entryId: queued.message?.inboxEntryId },
        "dropping stale queued inbox delivery after recovery cleared local custody",
      );
      this.pendingQueue.splice(index, 1);
    }
    const nextIndex = this.pendingQueue.findIndex(
      (queued) => this.queuedMessageStillOwned(queued) && !this.inboxDelivery.hasRecoveryDebt(queued.chatId),
    );
    if (nextIndex < 0) return;
    const next = this.pendingQueue[nextIndex];
    if (!next) return;
    const existing = this.sessions.get(next.chatId);
    if (existing?.status === "active") {
      this.pendingQueue.splice(nextIndex, 1);
      if (!next.message) {
        this.drainPendingQueue();
        return;
      }
      this.routeMessage(next.chatId, next.message, next.deliveryKind).catch((err) => {
        const hasInboxEntryId = next.message?.inboxEntryId !== undefined;
        this.config.log.warn({ chatId: next.chatId, hasInboxEntryId, err }, "pending drain error");
        if (next.message && hasInboxEntryId) {
          this.retryDeliveryTurn(next.chatId, next.message, "pending_drain_failed");
        } else {
          this.pendingQueue.unshift(next);
        }
      });
      return;
    }
    if (
      this._activeCount >= this.config.concurrency &&
      !this.findOldestActiveSession(
        (session) => session.chatId !== next.chatId && !this.inboxDelivery.hasProcessingOwnedWork(session.chatId),
      )
    ) {
      return;
    }

    this.pendingQueue.splice(nextIndex, 1);
    if (!next.message) {
      const session = this.sessions.get(next.chatId);
      if (session && session.status !== "active") {
        this.resumeSession(session, undefined, next.deliveryKind).catch((err) => {
          this.config.log.warn({ chatId: next.chatId, err }, "pending resume drain error");
          this.pendingQueue.unshift(next);
        });
      }
      return;
    }
    // Route asynchronously — the delivery work is already tracked by the
    // coordinator from the original `dispatch`.
    const message = next.message;
    this.routeMessage(next.chatId, message, next.deliveryKind).catch((err) => {
      const hasInboxEntryId = message.inboxEntryId !== undefined;
      this.config.log.warn({ chatId: next.chatId, hasInboxEntryId, err }, "pending drain error");
      if (hasInboxEntryId) {
        this.retryDeliveryTurn(next.chatId, message, "pending_drain_failed");
      } else {
        this.pendingQueue.unshift(next);
      }
    });
  }

  private evictIfNeeded(chatId?: string, message?: SessionMessage, deliveryKind: SlotDeliveryKind = "fresh"): boolean {
    const { max_sessions } = this.config.session;
    if (this.sessions.size < max_sessions) return true;

    // Prefer non-active sessions, then idle active sessions. Working active
    // sessions are not memory-management victims: dropping them silently loses
    // replies/tool side effects unless their work is explicitly recovered.
    // Within idle active sessions, deprioritize ones with a live background
    // subprocess (their watcher's completion wake-up cannot be recovered after
    // a shutdown) — they are evicted only as a last resort.
    let nonActiveCandidate: { key: string; session: SessionEntry } | null = null;
    let idleActiveCandidate: { key: string; session: SessionEntry } | null = null;
    let idleActiveSubprocessCandidate: { key: string; session: SessionEntry } | null = null;
    for (const [key, session] of this.sessions) {
      if (session.status !== "active") {
        if (!nonActiveCandidate || session.lastActivity < nonActiveCandidate.session.lastActivity) {
          nonActiveCandidate = { key, session };
        }
        continue;
      }
      if (!this.inboxDelivery.hasProcessingOwnedWork(key)) {
        if (this.hasLiveSubprocess(key)) {
          if (
            !idleActiveSubprocessCandidate ||
            session.lastActivity < idleActiveSubprocessCandidate.session.lastActivity
          ) {
            idleActiveSubprocessCandidate = { key, session };
          }
        } else if (!idleActiveCandidate || session.lastActivity < idleActiveCandidate.session.lastActivity) {
          idleActiveCandidate = { key, session };
        }
      }
    }

    const candidate = nonActiveCandidate ?? idleActiveCandidate ?? idleActiveSubprocessCandidate;
    if (!candidate) {
      if (chatId && message) {
        this.queueForSlot(chatId, message, deliveryKind, "max_sessions_all_working");
      } else {
        this.config.log.info({ maxSessions: max_sessions }, "max_sessions reached with no idle eviction candidate");
      }
      return false;
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
    return true;
  }

  /**
   * Reclaim slots whose sessions have gone quiet.
   *
   * Invariants this routine relies on:
   *   1. `lastActivity` is monotonic per session and is bumped by every
   *      inbound activity — `dispatch` (new chat / resume), `inject`
   *      (mid-turn message), and the handler's provider-activity callback.
   *   2. The coordinator is the source of truth for unsettled delivery work.
   *      Delivery/commit debt does not make a provider busy; only
   *      processing-owned work gets working grace.
   *   3. `working_grace_seconds` is an UPPER bound on how long processing
   *      work can hold a slot past `idle_timeout`.
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
      const hasProcessingWork = this.inboxDelivery.hasProcessingOwnedWork(session.chatId);
      // A live background subprocess (e.g. a `run_in_background` watcher) is
      // real in-flight work even though no turn is processing: suspending would
      // close the provider stream and lose its completion wake-up.
      const hasLiveSubprocess = this.hasLiveSubprocess(session.chatId);

      // Hard cap: regardless of unsettled work, once we are past
      // `idle_timeout + working_grace_seconds` the slot MUST be reclaimed.
      // Anything else means a stuck handler — or a forgotten background
      // subprocess — can hold a slot forever just by never closing the work.
      const pastHardCap = inactiveMs >= timeoutMs + workingGraceMs;

      if ((hasProcessingWork || hasLiveSubprocess) && !pastHardCap) {
        this.config.log.info(
          {
            chatId: session.chatId,
            runtimeState: currentState,
            inactiveSec: Math.round(inactiveMs / 1000),
            graceSec: this.config.session.working_grace_seconds,
            reason: hasProcessingWork ? "processing_work" : "live_subprocess",
          },
          "session idle threshold reached but work is still in flight — skipping suspend",
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
    const currentSdk = () => this.config.sdk;
    // Runtime-facing string log (handler + result-sink expect a simple
    // `(msg: string) => void` signature). The child pino logger still goes
    // to other places that want structured fields.
    const log = (msg: string) => sessionLog.info(msg);

    // One participant cache per session — consumed by formatInboundContent
    // (for resolving `[From: <name>]`). First use triggers a fetch; subsequent
    // calls hit memory. v1 §四 改造 4 removed result-sink's dependency on
    // this cache (the trigger-sender mention branch is gone), so the cache
    // now flows only into the inbound-formatter path.
    const participants = createParticipantCache(currentSdk, chatId, log);

    // Cross-agent doc preview: `workspaceRoot` is `<workspaces>/<agentSlug>`
    // (see agent-slot.ts), so the shared common root is its parent and this
    // agent's slug is its basename — derived from existing config, no new
    // config surface (decision: config-ascent).
    const workspacesRoot = dirname(this.config.handlerConfig.workspaceRoot);
    const selfSlug = basename(this.config.handlerConfig.workspaceRoot);
    // Resolve the self-fence SYNCHRONOUSLY from the already-populated config
    // cache so it can ride the agent's env (`buildAgentEnv` is sync). This
    // lets a `<binName> chat send` sub-process snapshot referenced docs. (The
    // result-sink's own doc-capture was retired with the final-text mirror, so
    // this snapshot path now serves the CLI `chat send` sub-process only.) The
    // legacy `base` env var (`FIRST_TREE_DOC_BASE`) is
    // kept emitting the OLD source-repo-top semantics so a stale pre-fix
    // `chat send` binary inherited from this process still snapshots like it
    // used to — see `agent-io.ts` for the wire-compat plumbing.
    const workspaceRoot = this.config.handlerConfig.workspaceRoot;
    const sessionRoot = resolveSessionDocRoot(workspaceRoot, chatId);
    const cachedPayload = this.config.agentConfigCache?.get(this.config.agentIdentity.agentId)?.payload ?? null;
    const selfFence = selfFenceFromRuntimeConfig(cachedPayload, sessionRoot, workspaceRoot);
    const docBase = cachedPayload
      ? documentBasePathFromRuntimeConfig(cachedPayload, sessionRoot, workspaceRoot)
      : sessionRoot;

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
      getOrgId: () => this.resolveChatOrgId(log, chatId),
      workspacesRoot,
      selfSlug,
    });

    const envCtx = {
      sdk: {
        get serverUrl() {
          return currentSdk().serverUrl;
        },
        get runtimeSessionToken() {
          return currentSdk().runtimeSessionToken;
        },
      },
      agent: this.config.agentIdentity,
      chatId,
      clientId: typeof this.config.handlerConfig.clientId === "string" ? this.config.handlerConfig.clientId : undefined,
      runtimeSessionTokenFile: this.config.runtimeSessionTokenFile,
      provider:
        typeof this.config.handlerConfig.runtimeProvider === "string"
          ? this.config.handlerConfig.runtimeProvider
          : undefined,
      log,
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
      get sdk() {
        return currentSdk();
      },
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
        this.captureRuntimeFailureNotice(chatId, event);
      },
      emitEventConfirmed: (event) => this.confirmSessionEventOrThrow(chatId, event),
      forwardResult,
      markMessagesConsumed: (messages) => {
        this.inboxDelivery.markProcessingStarted(chatId, messages);
      },
      finishTurn: (messages, outcome) => {
        return this.completeDeliveryTurn(chatId, messages, outcome);
      },
      retryTurn: (messages, reason) => {
        this.retryDeliveryTurn(chatId, messages, reason);
        this.projectSessionRuntime(chatId);
      },
      failSessionForRecovery: (reason, sessionId) => {
        this.failSessionForRecovery(chatId, reason, sessionId);
      },
      replaceSessionId: (sessionId, reason) => {
        const entry = this.sessions.get(chatId);
        if (!entry) return;
        const previousSessionId = entry.claudeSessionId;
        entry.claudeSessionId = sessionId;
        entry.lastActivity = Date.now();
        this.config.log.info({ chatId, previousSessionId, sessionId, reason }, "session id replaced by handler");
        this.persistRegistry();
      },
      buildAgentEnv: (parentEnv) => buildAgentEnv(parentEnv, envCtx),
      formatInboundContent: (message) => formatInboundContent(message, participants),
      resolveSenderLabel: async (senderId) => resolveSenderLabel(senderId, await participants.get()),
      formatFromHeader: (message) => buildFromHeader(message, participants),
    };
  }

  private async confirmSessionEventOrThrow(chatId: string, event: SessionEvent): Promise<void> {
    if (!this.config.confirmSessionEvent) {
      this.config.onSessionEvent?.(chatId, event);
      throw new Error("confirmed session event channel unavailable");
    }
    await this.config.confirmSessionEvent(chatId, event);
    this.captureRuntimeFailureNotice(chatId, event);
  }

  private async resolveSelfFence(log: (msg: string) => void, chatId: string): Promise<SelfFence> {
    // Session doc root: the dir the handler actually hands the agent as cwd —
    // the per-agent home for new chats, the legacy `<workspaceRoot>/<chatId>/`
    // dir for pre-#506 chats. See `resolveSessionDocRoot` (read-only existsSync;
    // no acquire* side effects on every outbound message).
    const workspaceRoot = this.config.handlerConfig.workspaceRoot;
    const sessionRoot = resolveSessionDocRoot(workspaceRoot, chatId);
    if (!this.config.agentConfigCache) return { agentHome: sessionRoot };
    try {
      const { payload } = await this.config.agentConfigCache.refreshIfNewer(this.config.agentIdentity.agentId, 0);
      return selfFenceFromRuntimeConfig(payload, sessionRoot, workspaceRoot);
    } catch (err) {
      log(
        `document preview self-fence: config unavailable, using agent home only: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { agentHome: sessionRoot };
    }
  }

  /**
   * Resolve the organization id a chat belongs to, for doc-capture uploads
   * (`POST /orgs/:orgId/attachments`). Cached permanently (a chat's org never
   * changes). Returns `null` when the lookup fails so the sink degrades doc
   * mentions to plain text instead of blocking the message.
   */
  private async resolveChatOrgId(log: (msg: string) => void, chatId: string): Promise<string | null> {
    const cached = this.chatOrgIds.get(chatId);
    if (cached) return cached;
    try {
      const detail = await this.config.sdk.getChatDetail(chatId);
      const orgId = detail.organizationId;
      if (typeof orgId === "string" && orgId.length > 0) {
        this.chatOrgIds.set(chatId, orgId);
        return orgId;
      }
      return null;
    } catch (err) {
      log(
        `doc capture: org lookup failed, doc mentions stay plain text: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private projectSessionRuntime(chatId: string, opts: { drainPendingOnIdle?: boolean } = {}): void {
    const session = this.sessions.get(chatId);
    const state = this.projectedRuntimeState(chatId, session ?? null);
    if (!state) {
      if (this.sessionRuntimeStates.delete(chatId)) this.recomputeRuntimeState();
      return;
    }
    const previous = this.sessionRuntimeStates.get(chatId);
    if (previous === state) return;
    this.sessionRuntimeStates.set(chatId, state);
    this.config.onSessionRuntimeChange?.(chatId, state);
    this.recomputeRuntimeState();
    if (state === "idle" && opts.drainPendingOnIdle !== false && this.pendingQueue.length > 0) {
      this.drainPendingQueue();
    }
  }

  private projectedRuntimeState(chatId: string, session: SessionEntry | null): RuntimeState | null {
    if (!session) return null;
    if (session.status === "errored") return "error";
    if (session.status !== "active") return null;
    return this.inboxDelivery.hasProcessingOwnedWork(chatId) ? "working" : "idle";
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
  getSessionRuntimeStates(
    activeChatIds: RuntimeSyncActiveSet = null,
  ): Array<{ chatId: string; runtimeState: RuntimeState }> {
    const out: Array<{ chatId: string; runtimeState: RuntimeState }> = [];
    for (const [chatId, session] of this.sessions) {
      if (!this.shouldIncludeInRuntimeSync(chatId, activeChatIds)) continue;
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
      source: msg.source,
      createdAt: msg.createdAt,
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
