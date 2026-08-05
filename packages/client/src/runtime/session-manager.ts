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
  INBOX_FENCE_PROBE_MAX_IDS,
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
  DeliveryCompletionDisposition,
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
  MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE,
  type ProviderFailureClassification,
} from "./provider-retry-policy.js";
import { redactErrorPreview } from "./redact-error-preview.js";
import { ReplayFenceStore } from "./replay-fence.js";
import { createResultSink, type Trigger } from "./result-sink.js";
import {
  isRuntimeSessionProofFailure,
  postProviderFailureRuntimeNotice,
  shouldPostProviderFailureRuntimeNotice,
} from "./runtime-notice.js";
import { SessionRegistry } from "./session-registry.js";

type SessionEntry = {
  chatId: string;
  claudeSessionId: string;
  handler: AgentHandler;
  status: SessionState;
  /** Whether this entry currently owns one unit of `_activeCount`. */
  activeSlotHeld: boolean;
  lastActivity: number;
  /** In-flight suspend promise; awaited before resume to avoid race conditions. */
  suspending: Promise<void> | null;
  /**
   * Failure of the last in-flight suspend, recorded because `suspending`
   * swallows rejections by contract. A terminate joining that suspend reads
   * this to fail the Reset apply instead of acking over a handler that was
   * never confirmed suspended. Cleared when a new suspend begins.
   */
  /**
   * Failure of the last in-flight suspend, recorded because `suspending`
   * swallows rejections by contract. A terminate joining that suspend reads
   * this to fail the Reset apply instead of acking over a handler that was
   * never confirmed suspended. Boxed (`{ error }`) because a Promise can
   * reject with a falsey value — truthiness of the raw error is not a
   * failure signal. Cleared when a new suspend begins.
   */
  suspendError: { error: unknown } | null;
  /**
   * The handler the suspend boundary already shut down successfully
   * (canceled-transition / retired-handler path), bound to the handler
   * IDENTITY rather than a boolean: later flows (e.g.
   * `handlerForRouteTransition`) may replace `entry.handler`, and a stale
   * boolean would then suppress teardown of the live replacement. Only
   * `handlerStoppedBySuspend === entry.handler` means the CURRENT handler is
   * confirmed stopped (`suspendError` records the failure case).
   */
  handlerStoppedBySuspend: AgentHandler | null;
  /**
   * Failure of the last terminate-driven strict teardown (boxed like
   * `suspendError`). Recorded because the slot is already released by then,
   * so without it a retry terminate would skip every teardown branch and
   * ack over a possibly-live handler.
   */
  teardownError: { error: unknown } | null;
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
  /**
   * Input for the current transient start/resume retry window. This is set at
   * the failure boundary from the message that actually failed, and cleared
   * once the retry succeeds or the retry state is torn down.
   */
  retryHeadMessage: SessionMessage | null;
  /**
   * Messages that arrived while a start/resume transition or its transient
   * retry is pending. They must
   * not replace `retryHeadMessage`: the older accepted inbox entry is still ahead
   * of them in the ACK prefix, so retry consumes the original trigger first and
   * injects these only after the handler is live again.
   */
  deferredMessages: SessionMessage[];
  /** Monotonic fence for start/resume attempts on this entry. */
  routeTransitionGeneration: number;
  /** The only start/resume attempt currently allowed to adopt provider state. */
  routeTransition: RouteTransitionToken | null;
  /**
   * True once the in-flight start/resume head has proven provider membership
   * via DeliveryToken.processingStarted. Same-chat tails may then cross
   * handler.inject while the route producer is still awaiting settlement;
   * until then they stay FIFO in deferredMessages.
   */
  routeInjectReady: boolean;
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

type RouteLeaseToken = {
  generation: number;
  handler: AgentHandler;
};

type RouteTransitionToken = RouteLeaseToken & {
  phase: "start" | "resume";
};

type SessionFailureHandling =
  | { kind: "retry" }
  | { kind: "terminal"; reasonCode: string; terminalEventPersisted: boolean };

type RuntimeFailureNoticePostResult =
  | { kind: "posted" }
  | { kind: "failed" }
  | { kind: "runtime_session_proof"; reasonCode: string };

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
 * This client's authoritative answer to "did the Reset fence for that
 * generation come down here?". The wire receipt is derived from it and never
 * from a caller's own bookkeeping: `accepted` / `idempotent` mean the fence
 * is lifted, `stale` means it is not.
 */
export type ResetFenceReleaseVerdict = "accepted" | "idempotent" | "stale";

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
  /**
   * Durable replay-fence store path. When set, the manager loads safety
   * facts about provider-entered deliveries that already produced unsafe
   * tool effects, refuses to start/resume a provider turn for a fenced
   * (chatId, messageId) redelivery (leaving it as unacknowledged recovery
   * debt), and hands the store to handlers via `handlerConfig.replayFence`.
   * A store that fails to load fails closed: every dispatch is withheld.
   */
  replayFencePath?: string;
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
   * Read-only settlement probe for concrete fenced deliveries: resolves
   * with the probed message ids the server proves settled (no unsettled
   * notify row), computed inside the server's serialized recovery
   * boundary. Without it the reconciliation keeps every fence.
   */
  probeFencedSettlement?: (chatId: string, messageIds: readonly string[]) => Promise<readonly string[]>;
  /**
   * Re-bind the owning agent after a bind-scoped HTTP proof failure. The
   * callback is agent-wide and must coalesce concurrent chat failures.
   */
  recoverRuntimeSessionProof?: (reasonCode: string) => Promise<void>;
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

/**
 * Minimum spacing between gate-triggered replay-fence reconciliations for
 * one chat. Withheld dispatches retry the server-truth readback so a
 * transient readback/clear failure converges without a process restart,
 * without turning every redelivery burst into an inbox-recovery storm.
 */
const REPLAY_FENCE_RECONCILE_INTERVAL_MS = 30_000;

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

/** Structured terminal provider-failure events that feed the durable runtime notice. */
function isTerminalProviderFailureSessionEvent(event: SessionEvent): boolean {
  if (event.kind !== "error") return false;
  const payload = parseProviderRetryEventMessage(event.payload.message);
  if (!payload) return false;
  return shouldPostProviderFailureRuntimeNotice(payload) || isRuntimeSessionProofFailure(payload);
}

function resumableProviderSessionId(...candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

/**
 * Normalize a recorded suspend/teardown failure for the terminate reject
 * boundary. Recorded errors can be falsey (a Promise may reject(null)), and
 * throwing a falsey value would make the rejection uninspectable downstream.
 */
function asTerminateError(kind: "suspend" | "teardown", error: unknown): Error {
  return error instanceof Error ? error : new Error(`session ${kind} failed: ${String(error)}`);
}

function previousAvailable(entry: SessionEntry): boolean {
  return resumableProviderSessionId(entry.claudeSessionId, entry.retryFromEvicted?.claudeSessionId) !== null;
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
  private readonly replayFence: ReplayFenceStore | null;
  /**
   * Set when the replay-fence store could not be loaded. Fail-closed: every
   * dispatch is withheld as recovery debt until an operator repairs the
   * store, because we can no longer tell safe redeliveries from unsafe ones.
   */
  private replayFenceUnavailable: string | null = null;
  private readonly pendingQueue: PendingMessage[] = [];
  /** Chats whose terminate command has closed admission but is still draining cleanup.
   *  The value is the in-flight termination promise: a duplicate terminate for
   *  the same chat joins it instead of returning early, so every ref'd caller
   *  acks only after the shared cleanup settles (applied:false on rejection). */
  private readonly terminatingChats = new Map<string, Promise<void>>();
  /**
   * Chats whose terminate cleanup finished in memory but whose final
   * synchronous registry flush failed. Counted as "work to do" by the
   * terminate admission guard so a retry re-executes the full termination
   * (and re-attempts the flush) instead of early-returning a false
   * applied:true while the stale mapping is still on disk. Also fences
   * every provider route admission until that retry succeeds — otherwise an
   * intervening start can consume the pending Reset nonce that the retry
   * later records as the durable retirement tombstone.
   */
  private readonly terminatePersistFailures = new Set<string>();
  /**
   * Chats with Reset-fence parked debt that must not admit a provider route
   * or same-socket recoverChat until {@link releaseParkedResetFenceRecovery}
   * runs after an exact receipted post-apply terminal disposition
   * (`finalized` or `aborted`). Survives a failed terminate attempt (teardown /
   * quiesce / flush) so parked rows stay parked — clearing only
   * `terminatingChats` must not release them.
   */
  private readonly awaitingResetFenceRelease = new Set<string>();
  /**
   * THE Reset-generation authority for this client: `chatId → generation`.
   * The manager owns it outright — no other component keeps a parallel map
   * or decides release on its own, because only the manager knows which
   * refs share a termination and which generation is current.
   *
   * A generation is created by a ref'd terminate that runs its own
   * termination, and every later ref that JOINS that same in-flight
   * termination is recorded as an alias of it (`refs`) rather than
   * superseding it: concurrent Resets A and B that share one termination
   * promise share one local outcome, so either one's exact receipted terminal
   * disposition (`finalized` or `aborted`) is an honest release. A ref'd
   * terminate that starts a fresh termination replaces the entry, which is
   * what makes an older generation's aliases stale.
   *
   * `released` keeps the entry as a tombstone after the accepted release so
   * a duplicate disposition for the same generation answers `idempotent`
   * (honest: this client did release that generation) without opening a
   * second recovery.
   */
  private readonly resetGenerations = new Map<string, { refs: Set<string>; released: boolean }>();
  /**
   * Coalesce one post-disposition recovery per chat so duplicate or
   * concurrent release calls cannot open repeated same-socket recoverChat
   * calls.
   */
  private readonly postResetFenceRecoveryScheduled = new Set<string>();
  /**
   * Per-chat teardown debt: handlers detached from their SessionEntry (LRU
   * eviction, failSessionForRecovery, abortUnownedRoute, terminal cleanup,
   * canceled fresh-start, resume/retry handler replacement) without a
   * CONFIRMED stop. A ref'd terminate joins/strictly tears down every
   * pending handler of the chat before it may ack; confirmed stops drop out
   * of the set. Entries are registered at the detach point (see
   * `detachHandlerWithPendingTeardown` / `registerPendingTeardown`).
   */
  private readonly pendingTeardowns = new Map<string, Set<AgentHandler>>();
  /**
   * In-flight route producers (start/resume/retry provider calls), per chat.
   * Tracked from `beginRouteTransition` until the route settles: a canceled
   * transition can still MATERIALIZE late (the provider call returns after
   * its pre-materialization shutdown ran as a no-op), and only the
   * producer's settle funnels that materialization into
   * `discardStaleRouteTransition` → teardown debt. Terminate and manager
   * shutdown join these before they may ack/return.
   */
  private readonly routeProducers = new Map<string, Set<Promise<void>>>();
  /**
   * Per-chat single-flight registry for `runRetry` executions. An
   * overlapping trigger (timer fire + immediate delivery trigger) joins the
   * in-flight execution instead of running a second one — see runRetry.
   */
  private readonly retryFlights = new Map<string, Promise<void>>();
  /** Monotonic fence for delivery work that is still inside the async admission pipeline. */
  private readonly admissionGenerations = new Map<string, number>();
  /** One-way lifecycle fence: no provider route may be adopted after manager shutdown begins. */
  private shuttingDown = false;
  private readonly lastReportedStates = new Map<string, SessionState>();
  private readonly sessionRuntimeStates = new Map<string, RuntimeState>();
  /** Chats held specifically for a fresh bind, never same-socket recovery. */
  private readonly runtimeProofRecoveryChats = new Set<string>();
  /** Handlers invalidated while start/resume was unresolved must never be reused. */
  private readonly retiredHandlers = new WeakSet<AgentHandler>();
  /**
   * Coalesces concurrent cleanup; a stale settlement may enqueue a later
   * cleanup pass. Each entry keeps both faces of the shutdown: `raw`
   * (rejects on failure) for `observeFailure` callers such as the Reset
   * terminate, and `observed` (swallow-and-warn, always resolves) for
   * fire-and-forget callers — so a strict caller joining an in-flight
   * shutdown that a lenient caller started still sees the failure.
   */
  private readonly handlerShutdowns = new WeakMap<AgentHandler, { raw: Promise<void>; observed: Promise<void> }>();
  private lastReportedRuntimeState: RuntimeState | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeReaffirmTimer: ReturnType<typeof setTimeout> | null = null;
  private _activeCount = 0;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.inboxDelivery = new InboxDeliveryCoordinator({
      ackEntry: config.ackEntry,
      recoverChat: config.recoverChat,
      postRuntimeFailureNotice: async (chatId, payload) => {
        await postProviderFailureRuntimeNotice(this.config.sdk, chatId, payload);
      },
      onWorkChanged: (chatId) => this.projectSessionRuntime(chatId),
      onDeliveriesCommitted: (chatId, messageIds) => this.reconcileReplayFences(chatId, messageIds),
      log: config.log,
    });
    this.registry = config.registryPath ? new SessionRegistry(config.registryPath) : null;
    if (config.replayFencePath) {
      this.replayFence = new ReplayFenceStore(config.replayFencePath);
      try {
        this.replayFence.load();
      } catch (err) {
        this.replayFenceUnavailable = err instanceof Error ? err.message : String(err);
        this.config.log.error(
          { err, path: config.replayFencePath },
          "replay fence store failed to load; withholding all provider dispatch fail-closed",
        );
      }
    } else {
      this.replayFence = null;
    }
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
    const admissionGeneration = this.admissionGenerations.get(chatId) ?? 0;
    const admissionValid = () =>
      !this.shuttingDown &&
      (this.admissionGenerations.get(chatId) ?? 0) === admissionGeneration &&
      !this.isProviderRouteAdmissionFenced(chatId);
    const suspending = this.sessions.get(chatId)?.suspending;
    if (suspending) await suspending;
    const isRecoveryRedelivery = this.inboxDelivery.takeRecoveryActivationReady(chatId);

    if (
      !isRecoveryRedelivery &&
      // Never open same-socket recovery while Reset admission is fenced:
      // recoverChat would redeliver the same unacked rows into the fence and
      // trip the server's no-progress circuit.
      !this.isProviderRouteAdmissionFenced(chatId) &&
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
            const proofReason = this.runtimeSessionProofReasonForError(err);
            if (proofReason && (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, message, proofReason))) {
              return;
            }
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

        if (!admissionValid()) {
          if (this.inboxDelivery.hasEntry(work)) {
            if (this.isProviderRouteAdmissionFenced(chatId)) {
              await this.parkDeliveryBehindResetAdmissionFence(chatId, message);
            } else {
              this.retryDeliveryTurn(chatId, message, "delivery_admission_invalidated");
            }
          }
          return;
        }
        if (!this.inboxDelivery.hasEntry(work)) return;

        // 5. Route by session state. ACK no longer happens inside route — the
        // entry sits in the coordinator ledger until the handler completes the
        // concrete message/batch it actually consumed. Do not await inside the
        // admission barrier: for Codex/TUI, route promises can span the whole
        // turn, but same-chat later messages must still be able to append once
        // this entry has reached handler membership.
        const deliveryKind: SlotDeliveryKind = isRecoveryRedelivery ? "recovery" : "fresh";
        routePromise = this.routeMessage(chatId, message, deliveryKind).catch(async (err) => {
          if (this.inboxDelivery.hasEntry(work)) {
            const proofReason = this.runtimeSessionProofReasonForError(err);
            if (proofReason && (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, message, proofReason))) {
              return;
            }
            this.retryDeliveryTurn(chatId, message, "route_message_failed");
          }
          throw err;
        });
      });
    } catch (err) {
      if (this.inboxDelivery.hasEntry(work)) {
        const proofReason = this.runtimeSessionProofReasonForError(err);
        if (proofReason && (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, message, proofReason))) {
          return;
        }
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

  /**
   * Handle a server-issued session command. Terminate drops all local state
   * without reporting back. `resetRef` is the ref'd Reset generation this
   * terminate belongs to — it arms the parked-fence release so only that
   * generation's exact receipted terminal disposition (`session:command:finalized`
   * or `session:command:aborted`) can lift the fence.
   */
  async handleCommand(chatId: string, command: SessionCommandType, options?: { resetRef?: string }): Promise<void> {
    const inFlightTermination = this.terminatingChats.get(chatId);
    if (inFlightTermination) {
      // A duplicate terminate joins the in-flight cleanup instead of
      // returning early: a ref'd caller (Reset apply-ack) must only resolve
      // after the shared work settles, and must reject if it rejects.
      // Suspend/resume keep the early-return admission fence.
      if (command === "session:terminate") {
        // A joining ref'd Reset shares this one termination, so it becomes an
        // ALIAS of the generation that termination arms rather than
        // superseding it: both Resets have the same local outcome, so either
        // one's exact receipted terminal disposition is an honest release, and
        // neither may invalidate the other's.
        if (options?.resetRef !== undefined) {
          const joiningRef = options.resetRef;
          return inFlightTermination.then(() => {
            this.armParkedResetFenceRelease(chatId, joiningRef, { join: true });
          });
        }
        return inFlightTermination;
      }
      return;
    }

    if (command === "session:suspend") {
      const session = this.sessions.get(chatId);
      this.invalidateDeliveryAdmission(chatId);
      if (session) this.clearRetryState(session);
      if (session?.activeSlotHeld) {
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
      if (current?.retryAttempt && current.status === "suspended" && !current.activeSlotHeld) {
        this.triggerImmediateRetry(chatId);
      } else if (
        current &&
        (current.status === "suspended" || current.status === "evicted") &&
        !current.activeSlotHeld
      ) {
        this.config.log.info({ chatId }, "resume command received");
        await this.resumeSession(current, undefined, "fresh");
      }
      this.projectSessionRuntime(chatId);
      this.drainPendingQueue();
      return;
    }

    if (command === "session:terminate") {
      const session = this.sessions.get(chatId);
      // NOTE: there is deliberately NO no-work early return. Empty memory
      // (no session, mapping, queue, custody, failure marker, debt, or
      // producer) proves nothing about the DISK registry — a mapping
      // persisted earlier (e.g. at suspend time) may still be on disk and
      // would be reloaded as an evicted mapping after a crash, reviving the
      // old provider thread. Every apply-acked terminate therefore runs the
      // full body below, whose final step durably flushes the authoritative
      // registry snapshot (see flushTerminateRegistry).
      this.invalidateDeliveryAdmission(chatId);
      this.config.log.info({ chatId }, "terminate command received");
      const termination = (async () => {
        if (session?.retryTimer) {
          clearTimeout(session.retryTimer);
          session.retryTimer = null;
        }
        if (session) this.invalidateRouteTransition(session, "session_terminated");
        // Join an in-flight suspend before any state deletion: handler.suspend()
        // may still be running, and the slot was already released so the
        // activeSlotHeld teardown below would never fire. `suspending` never
        // rejects (legacy resolve-always contract for dispatch/resume), so the
        // outcome recorded on the entry is what lets a failed suspend fail the
        // apply instead of acking over a possibly-live handler.
        const joinedSuspend = session?.suspending != null;
        if (session?.suspending) await session.suspending;
        if (joinedSuspend && session?.suspendError) throw asTerminateError("suspend", session.suspendError.error);
        const activeSlotHeld = session?.activeSlotHeld === true;
        if (session) this.releaseActiveSlot(session);
        // The teardown boundary — strict in every case, because a
        // handler.shutdown rejection must fail the apply (applied:false),
        // never resolve into an ack over a possibly-live handler. Beyond the
        // slot-held ordinary case, teardown is also required when a joined
        // suspend left the handler live, or when a recorded
        // suspendError/teardownError says the old run was never confirmed
        // stopped (retry path: `suspending` is null again and the slot is
        // already released, so without the recorded errors no teardown branch
        // would fire). `handlerStoppedBySuspend` marks the case where the
        // suspend boundary already completed the shutdown of the CURRENT
        // handler — tearing down again would double-shutdown. It is bound to
        // the handler identity, so a replacement handler (installed e.g. by
        // `handlerForRouteTransition` after the old one was retired) never
        // inherits the exemption and is always torn down. A teardown failure
        // is recorded on the
        // entry (boxed: rejections can be falsey) so a genuine retry
        // re-attempts it instead of turning into a false success; on success
        // the entry is deleted below, retiring the recorded errors with it.
        const needsTeardown =
          session != null &&
          session.handlerStoppedBySuspend !== session.handler &&
          (activeSlotHeld || joinedSuspend || session.suspendError != null || session.teardownError != null);
        if (session && needsTeardown) {
          try {
            await this.shutdownHandler(session.handler, "session_terminated", { observeFailure: true });
          } catch (err) {
            session.teardownError = { error: err };
            throw asTerminateError("teardown", err);
          }
        }

        // Join the chat's in-flight route producers BEFORE draining debt: a
        // canceled start/resume can still materialize late, and only its
        // settle funnels that materialization into
        // `discardStaleRouteTransition` → fresh teardown debt. The drain
        // below must see that complete debt, so this quiesce runs first.
        await this.quiesceRouteProducers(chatId);

        // Settle every pending teardown debt for this chat: handlers detached
        // from their entry (eviction / recovery / abort / terminal cleanup /
        // canceled fresh-start / replacement) without a confirmed stop must
        // be confirmed stopped before the apply may ack. A failure keeps the
        // debt registered and rejects — the retry re-attempts it (coalescing
        // joins any still in-flight shutdown's raw face), so the loop
        // converges instead of acking over a live old run.
        // Drain to a STABLE empty: awaiting one shutdown can let another
        // lifecycle path register fresh debt for this chat mid-drain (e.g. a
        // concurrent max-session eviction of the still-present session), so
        // loop until a full scan finds nothing left.
        for (;;) {
          const pendingTeardown = this.pendingTeardowns.get(chatId);
          if (!pendingTeardown || pendingTeardown.size === 0) break;
          for (const pendingHandler of [...pendingTeardown]) {
            try {
              await this.shutdownHandler(pendingHandler, "session_terminated", { observeFailure: true });
              this.dropPendingTeardown(chatId, pendingHandler);
            } catch (err) {
              throw asTerminateError("teardown", err);
            }
          }
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
        // but coordinator keeps any uncommitted tail as recovery debt. Defer
        // same-socket recoverChat until the admission fence clears so fenced
        // redelivery cannot open the server's no-progress circuit.
        await this.inboxDelivery.drainForTerminate(chatId, { requestNow: false });

        this.recomputeRuntimeState();
        this.flushTerminateRegistry(chatId);
        this.drainPendingQueue();
      })();
      this.terminatingChats.set(chatId, termination);
      try {
        await termination;
        // Local terminate succeeded (flush included). A ref'd Reset arms a
        // fresh generation and keeps provider admission fenced until that
        // generation's exact receipted terminal disposition (`finalized` or
        // `aborted`), whether or not anything is parked yet — do NOT recover
        // here (that races session:command:applied / the disposition).
        this.armParkedResetFenceRelease(chatId, options?.resetRef);
      } finally {
        // Drop the in-flight fence only if this run is still the current one —
        // a failure leaves room for a genuine later retry without clobbering a
        // newer in-flight termination. Parked Reset debt stays armed via
        // awaitingResetFenceRelease until releaseParkedResetFenceRecovery.
        if (this.terminatingChats.get(chatId) === termination) {
          this.terminatingChats.delete(chatId);
        }
      }
    }
  }

  /**
   * Durably flush the authoritative registry snapshot for a Reset
   * terminate. The Reset apply-ack is only truthful once the mapping
   * deletion AND the per-chat Reset fresh-start nonce are durable: a crash
   * between ack and a debounced write would reload the stale mapping (or
   * lose the tombstone) on restart and revive the old provider session.
   * The flush is the CURRENT authoritative snapshot (all chats' mappings
   * plus every Reset nonce), so other chats are preserved, and it cancels
   * any older pending debounced snapshot so a stale write cannot resurrect
   * the deletion or erase the tombstone later. A failed flush keeps the
   * in-memory pending nonce for the genuine retry. A failure is recorded in
   * terminatePersistFailures so a retry terminate re-runs the full body
   * (and re-attempts the flush) instead of a false applied:true.
   */
  private flushTerminateRegistry(chatId: string): void {
    try {
      // Rotate once per in-flight Reset attempt before the durable write.
      // flushOrThrow failure retains this nonce for the genuine retry.
      this.registry?.rotateFreshStartNonce(chatId);
      this.persistRegistry({ throwOnFailure: true });
      this.registry?.markResetNonceDurable(chatId);
      this.terminatePersistFailures.delete(chatId);
    } catch (err) {
      this.terminatePersistFailures.add(chatId);
      throw err;
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
    // Unresolved teardown debt keeps the chat held: the handler is not
    // confirmed stopped, so the server must keep this chat in the sync set —
    // dropping it would lose the reconcile retry channel for the debt.
    for (const id of this.pendingTeardowns.keys()) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    // In-flight route producers hold the chat the same way: a canceled
    // start/resume can still materialize late, so the server must keep the
    // chat in the sync set until the producer settles and its
    // materialization is confirmed stopped.
    for (const id of this.routeProducers.keys()) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    // Unresolved Reset retirement (in-flight terminate, failed durable flush,
    // or parked Reset-fence debt awaiting an exact receipted terminal
    // disposition) force-keeps the chat: the server must retain reconcile
    // authority until mapping deletion + Reset nonce are durably written and
    // parked debt is released.
    for (const id of this.terminatingChats.keys()) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    for (const id of this.terminatePersistFailures) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    for (const id of this.awaitingResetFenceRelease) {
      if (this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    // An armed Reset generation holds the chat too: between `applied` and the
    // exact accepted terminal disposition (`finalized` or `aborted`) the server
    // must keep reconcile authority even when nothing is parked behind the
    // fence yet.
    for (const id of this.resetGenerations.keys()) {
      if (this.hasArmedResetGeneration(id) && this.shouldIncludeInRuntimeSync(id, activeChatIds)) ids.add(id);
    }
    return [...ids];
  }

  /**
   * Apply a server-declared stale list from `session:reconcile:result` — treat
   * each chatId as if a `session:terminate` command had arrived.
   */
  applyStaleChatIds(staleChatIds: string[]): void {
    for (const id of staleChatIds) {
      // Terminate is strict now (teardown/persist failures reject): observe
      // the rejection so a failed stale cleanup is logged instead of crashing
      // the client as an unhandled rejection. The strict boundary keeps the
      // entry/mapping intact on failure, so the next reconcile still finds
      // the chat locally held, declares it stale again, and retries.
      // Server already declared these chats stale, so release parked Reset-fence
      // debt after a successful local apply (no apply-ack finalize wait).
      // A reconcile result is a SNAPSHOT of older server state: it carries no
      // Reset generation, so the unref'd release refuses while a generation is
      // armed rather than lifting a newer Reset's fence behind its back. That
      // Reset's own receipted terminal disposition remains the only thing that
      // releases it.
      void this.handleCommand(id, "session:terminate")
        .then(() => {
          const verdict = this.releaseParkedResetFenceRecovery(id);
          if (verdict === "stale") {
            this.config.log.info(
              { chatId: id },
              "stale-reconcile terminate did not release the Reset fence; a newer Reset generation is armed",
            );
          }
        })
        .catch((err) => {
          this.config.log.warn({ chatId: id, err }, "stale session terminate failed; will retry on next reconcile");
        });
    }
  }

  /** Shut down all sessions gracefully. */
  async shutdown(reason?: string, opts: SessionManagerShutdownOptions = {}): Promise<void> {
    this.shuttingDown = true;
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
    for (const timer of this.replayFenceRetryTimers.values()) {
      clearTimeout(timer);
    }
    this.replayFenceRetryTimers.clear();
    for (const timer of this.postFenceRecoveryTimers.values()) {
      clearTimeout(timer);
    }
    this.postFenceRecoveryTimers.clear();

    const attemptedHandlers = new Set<AgentHandler>();
    const shutdowns = [...this.sessions.values()].map((session) => {
      // Fence new delivery admissions, but do NOT bump routeTransitionGeneration
      // or retire the handler yet: already-issued DeliveryTokens need a stable
      // settlement lease through settleProviderEntered notice-before-ACK.
      // `shuttingDown` already fails closed for adoption/mutation leases.
      this.invalidateDeliveryAdmission(session.chatId);
      // Stop every session handler whose stop is unconfirmed:
      // - active-slot (may need settleProviderEntered notice-before-ACK);
      // - suspend boundary still in flight (join coalesced teardown);
      // - completed failed suspend/teardown markers (`suspendError` /
      //   `teardownError`) where the boundary left the handler live and
      //   `suspending` is already null — otherwise clearing `sessions`
      //   orphans the last owner with no shutdown attempt.
      // A successfully suspended, resource-closed handler
      // (`handlerStoppedBySuspend === handler`, no error markers) is kept
      // for resume and is not redundantly shut down here.
      const stopUnconfirmedAfterFailedBoundary =
        session.handlerStoppedBySuspend !== session.handler &&
        (session.suspendError != null || session.teardownError != null);
      if (!session.activeSlotHeld && session.suspending === null && !stopUnconfirmedAfterFailedBoundary) {
        return Promise.resolve();
      }
      attemptedHandlers.add(session.handler);
      return this.shutdownHandler(session.handler, reason ?? "manager_shutdown", {
        ...(session.activeSlotHeld ? { settleProviderEntered: true } : {}),
        // Failed-boundary / in-flight-suspend stops are best-effort on the
        // manager face — do not reject the whole client shutdown.
        ...(!session.activeSlotHeld ? { observeFailure: true } : {}),
      });
    });
    // Detached handlers recorded as teardown debt have no entry left to reach
    // them — manager shutdown is their last owner. Best-effort stop for each
    // unique one (deduped across chats and against session handlers;
    // coalescing joins any still in-flight shutdown), with the same
    // allSettled semantics as the session loop above. The raw face clears
    // the debt under EVERY chat that registered the handler on a confirmed
    // stop, so the bounded pass below only ever sees handlers whose stop is
    // genuinely unconfirmed.
    const debtChatsByHandler = new Map<AgentHandler, string[]>();
    for (const [chatId, pending] of this.pendingTeardowns) {
      for (const pendingHandler of pending) {
        const chatIds = debtChatsByHandler.get(pendingHandler) ?? [];
        chatIds.push(chatId);
        debtChatsByHandler.set(pendingHandler, chatIds);
      }
    }
    for (const [pendingHandler, chatIds] of debtChatsByHandler) {
      if (attemptedHandlers.has(pendingHandler)) continue;
      attemptedHandlers.add(pendingHandler);
      shutdowns.push(
        this.shutdownHandler(pendingHandler, reason ?? "manager_shutdown", { observeFailure: true }).then(
          () => {
            for (const chatId of chatIds) this.dropPendingTeardown(chatId, pendingHandler);
          },
          () => {},
        ),
      );
    }
    await Promise.allSettled(shutdowns);

    // Settlement leases are closed. Invalidate in-flight start/resume adoption
    // now (Pi HEAD order: settle first, then invalidate) so a producer stuck on
    // pre-provider work (e.g. config refresh) can finish and the wait below
    // cannot hang manager shutdown.
    const shutdownReason = reason ?? "manager_shutdown";
    for (const session of this.sessions.values()) {
      this.invalidateRouteTransition(session, shutdownReason);
    }

    // Suspend boundaries AND route producers settling DURING the sweep can
    // register fresh teardown debt (a canceled fresh-start whose stop just
    // failed; a late-materializing canceled route whose discard fires now).
    // Wait for any still in flight — awaiting `suspending` / a producer
    // covers the finally/discard where the debt lands — then give every
    // handler still in debt one bounded best-effort (re)try: remaining debt
    // after the quiesce means the stop is unconfirmed (failed sweep attempt,
    // failed detach, or a late afterPrior stop that just failed), and
    // manager shutdown is the last owner able to retry. Exactly one pass,
    // observed face: shutdown stays best-effort and never blocks on a
    // handler that will not die.
    await Promise.allSettled([
      ...[...this.sessions.values()]
        .map((session) => session.suspending)
        .filter((pending): pending is Promise<void> => pending !== null),
      ...[...this.routeProducers.values()].flatMap((producers) => [...producers]),
    ]);
    const retriedHandlers = new Set<AgentHandler>();
    for (const pending of this.pendingTeardowns.values()) {
      for (const pendingHandler of [...pending]) {
        if (retriedHandlers.has(pendingHandler)) continue;
        retriedHandlers.add(pendingHandler);
        // Each attempt joins a still in-flight shutdown when one exists; a
        // failure earns exactly ONE fresh retry — bounded, so manager
        // shutdown never blocks on a handler that will not die.
        const stopOnce = (): Promise<boolean> =>
          this.shutdownHandler(pendingHandler, reason ?? "manager_shutdown", { observeFailure: true }).then(
            () => true,
            () => false,
          );
        if (!(await stopOnce()) && !(await stopOnce())) continue;
        for (const [id, set] of this.pendingTeardowns) {
          if (set.delete(pendingHandler) && set.size === 0) this.pendingTeardowns.delete(id);
        }
      }
    }

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
    this.runtimeProofRecoveryChats.clear();
    this.awaitingResetFenceRelease.clear();
    this.resetGenerations.clear();
    this.postResetFenceRecoveryScheduled.clear();
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
   * Release only chats fenced by a runtime-proof fault. The server completes
   * its delivered→pending reset before sending `agent:bound`, so clearing the
   * local ledgers here cannot lose custody and lets the post-bound drain
   * establish fresh ownership.
   */
  noteBindRecoveryComplete(): void {
    for (const chatId of this.runtimeProofRecoveryChats) {
      this.inboxDelivery.completeBindRecovery(chatId);
      this.projectSessionRuntime(chatId);
    }
    this.runtimeProofRecoveryChats.clear();
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
    // Unresolved teardown debt force-keeps the chat: its handler is not
    // confirmed stopped, so dropping the chat from the held report would
    // lose the reconcile retry channel for the debt.
    if (this.pendingTeardowns.has(chatId)) return true;
    // An in-flight route producer force-keeps the chat too: the canceled
    // start/resume can still materialize late, and the reconcile channel is
    // what retries its teardown if the stop fails.
    if ((this.routeProducers.get(chatId)?.size ?? 0) > 0) return true;
    // In-flight Reset drain or failed durable Reset flush: keep reconcile
    // authority until the successful terminate retry clears the fence.
    if (this.isProviderRouteAdmissionFenced(chatId)) return true;
    if (this.pendingQueue.some((queued) => queued.chatId === chatId)) return true;
    if (this.hasPendingTransientRetry(chatId)) return true;
    return this.inboxDelivery.hasUnsettledWork(chatId);
  }

  private invalidateDeliveryAdmission(chatId: string): void {
    this.admissionGenerations.set(chatId, (this.admissionGenerations.get(chatId) ?? 0) + 1);
  }

  /**
   * Combined provider-route admission fence for Reset: an in-flight
   * `session:terminate` drain (`terminatingChats`), a prior Reset whose
   * durable registry flush failed (`terminatePersistFailures`), or parked
   * Reset-fence debt still awaiting an exact receipted terminal disposition
   * (`awaitingResetFenceRelease`), or an armed Reset generation whose exact
   * `finalized`/`aborted` has not been accepted yet (`resetGenerations`) — that
   * last one fences the post-apply / pre-disposition window even when nothing
   * was parked at apply time. Must NOT be used for the duplicate-terminate
   * join lookup — a genuine retry terminate must still execute and clear the
   * persistence failure.
   */
  private isProviderRouteAdmissionFenced(chatId: string): boolean {
    return (
      this.terminatingChats.has(chatId) ||
      this.terminatePersistFailures.has(chatId) ||
      this.awaitingResetFenceRelease.has(chatId) ||
      this.hasArmedResetGeneration(chatId)
    );
  }

  /**
   * Retain coordinator custody for a delivery that hit the Reset admission
   * fence without requesting same-socket recoverChat. Generic
   * `retryDeliveryTurn` would immediately recover, redeliver into the same
   * fence, and open the server's no-progress circuit after repeated identical
   * resets. Parked debt is released once by {@link releaseParkedResetFenceRecovery}
   * after an exact receipted post-apply terminal disposition.
   */
  private async parkDeliveryBehindResetAdmissionFence(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
  ): Promise<void> {
    const messageIds = (Array.isArray(messages) ? messages : [messages]).map((message) => message.id);
    this.config.log.info(
      { chatId, messageIds },
      "parking delivery behind Reset admission fence without same-socket recovery",
    );
    this.awaitingResetFenceRelease.add(chatId);
    await this.inboxDelivery.parkTurnForDeferredRecovery(chatId, messages, "reset_admission_fence");
  }

  /** Is a Reset generation armed (created and not yet released) for this chat? */
  private hasArmedResetGeneration(chatId: string): boolean {
    const generation = this.resetGenerations.get(chatId);
    return generation !== undefined && !generation.released;
  }

  /**
   * After a successful local terminate, arm the chat's Reset fence for the
   * generation identified by `ref`.
   *
   * With a ref, the fence is armed UNCONDITIONALLY — even when nothing was
   * parked at apply time. Between `applied:true` and the server's exact
   * receipted terminal disposition (`finalized` or `aborted`) the old session
   * is already destroyed but the server has not finished its terminal branch,
   * so a row arriving in that window must park rather than start, resume, or
   * inject; a zero-debt shortcut here reopened exactly that
   * hole. Only the exact accepted release lifts it.
   *
   * `join` marks a ref that coalesced onto an in-flight termination: it
   * becomes an alias of that one generation instead of superseding it,
   * because both Resets share a single local outcome. Without `join` the ref
   * starts a fresh generation, which retires the previous one's aliases.
   *
   * An unref'd terminate has no generation to arm and must never weaken one:
   * it only keeps the legacy debt-scoped fence for chats with no armed
   * generation. Authoritative unref'd release goes through
   * {@link supersedeResetGeneration}.
   */
  armParkedResetFenceRelease(chatId: string, ref?: string, options?: { join?: boolean }): void {
    if (ref !== undefined) {
      const current = this.resetGenerations.get(chatId);
      if (options?.join === true && current !== undefined && !current.released) {
        current.refs.add(ref);
      } else {
        this.resetGenerations.set(chatId, { refs: new Set([ref]), released: false });
      }
      this.awaitingResetFenceRelease.add(chatId);
      return;
    }
    if (this.hasArmedResetGeneration(chatId)) return;
    if (this.terminatePersistFailures.has(chatId)) return;
    if (!this.inboxDelivery.hasRecoveryDebt(chatId) && !this.inboxDelivery.hasUnsettledWork(chatId)) {
      this.awaitingResetFenceRelease.delete(chatId);
      return;
    }
    this.awaitingResetFenceRelease.add(chatId);
  }

  /**
   * Release parked Reset-fence debt after an exact receipted post-apply
   * terminal disposition — either durable eviction (`session:command:finalized`)
   * or an abort/supersede (`session:command:aborted`) for the same generation.
   * Must not run from terminate's `finally` or from local flush success alone.
   *
   * Returns this client's authoritative verdict for the caller's receipt:
   *
   *   - `accepted`   — `ref` is an alias of the current generation and this
   *                    call performed the release;
   *   - `idempotent` — that generation was already released here (duplicate
   *                    or racing disposition), so the fence really is lifted
   *                    but nothing was recovered twice;
   *   - `stale`      — the ref belongs to no generation this client holds, a
   *                    newer generation has superseded it, or another
   *                    terminate boundary currently holds the chat closed.
   *                    Nothing is released, so a delayed disposition cannot
   *                    lift a newer Reset's fence and the operator's Reset
   *                    fails closed instead of reporting a lifted fence.
   *
   * Without `ref` this is the legacy debt-scoped release for chats with no
   * armed generation; it refuses (`stale`) while a generation is armed, so
   * incidental cleanup such as a delayed stale reconcile can never release
   * a Reset the server has not dispositioned. Authoritative unref'd callers use
   * {@link supersedeResetGeneration}.
   */
  releaseParkedResetFenceRecovery(chatId: string, ref?: string): ResetFenceReleaseVerdict {
    const generation = this.resetGenerations.get(chatId);
    if (ref === undefined) {
      if (generation !== undefined && !generation.released) {
        this.config.log.debug(
          { chatId, armedRefs: [...generation.refs] },
          "refusing unref'd Reset fence release while a Reset generation is armed",
        );
        return "stale";
      }
      return this.runParkedResetFenceRecovery(chatId) ? "accepted" : "stale";
    }
    if (generation === undefined || !generation.refs.has(ref)) {
      this.config.log.debug(
        { chatId, ref, armedRefs: generation ? [...generation.refs] : null },
        "ignoring Reset finalization for a ref that is not the armed generation",
      );
      return "stale";
    }
    if (generation.released) return "idempotent";
    if (!this.runParkedResetFenceRecovery(chatId)) return "stale";
    generation.released = true;
    return "accepted";
  }

  /**
   * Retire whatever Reset generation this chat holds and release its parked
   * debt. Reserved for callers with independent authority that the server
   * already finalized — today the legacy unref'd `session:terminate`, which
   * the server only sends after archiving. It is deliberately a separate
   * entry point: incidental cleanup must not reach this behaviour by passing
   * no ref.
   */
  supersedeResetGeneration(chatId: string, reason: string): ResetFenceReleaseVerdict {
    const generation = this.resetGenerations.get(chatId);
    if (generation !== undefined && !generation.released) {
      this.config.log.info({ chatId, reason, armedRefs: [...generation.refs] }, "superseding armed Reset generation");
    }
    this.resetGenerations.delete(chatId);
    return this.runParkedResetFenceRecovery(chatId) ? "accepted" : "stale";
  }

  /**
   * Lift the chat's admission fence and, if any debt is parked behind it,
   * open exactly one same-socket recovery. Coalesced per chat so concurrent
   * callers cannot issue repeated recoverChat calls. Returns false when
   * another terminate boundary (in-flight termination, failed durable flush)
   * still holds the chat closed — the fence stays up and the caller must
   * report the release as not done.
   */
  private runParkedResetFenceRecovery(chatId: string): boolean {
    if (this.terminatingChats.has(chatId) || this.terminatePersistFailures.has(chatId)) return false;
    if (this.postResetFenceRecoveryScheduled.has(chatId)) return true;
    this.postResetFenceRecoveryScheduled.add(chatId);
    this.awaitingResetFenceRelease.delete(chatId);
    try {
      if (this.inboxDelivery.hasRecoveryDebt(chatId) || this.inboxDelivery.hasUnsettledWork(chatId)) {
        void this.inboxDelivery.recoverIfNeeded(chatId, "reset_admission_fence_cleared");
      }
      return true;
    } finally {
      this.postResetFenceRecoveryScheduled.delete(chatId);
    }
  }

  private clearRetryAttemptState(entry: SessionEntry): void {
    if (entry.retryTimer) clearTimeout(entry.retryTimer);
    entry.retryAttempt = 0;
    entry.retryNextAt = null;
    entry.retryTimer = null;
    entry.lastRetryReason = null;
    entry.lastRetryCategory = null;
    entry.lastRetryScope = null;
    entry.lastRetryRawError = null;
    entry.retryHeadMessage = null;
  }

  private clearRetryState(entry: SessionEntry): void {
    this.clearRetryAttemptState(entry);
    entry.deferredMessages = [];
  }

  /**
   * Crash-safe fence reconciliation driven by per-delivery server
   * settlement truth. After a crash the local fence file can lag the
   * server: an entry ACKed just before the crash leaves a stale chat-wide
   * fence with no automatic cleanup. A read-only probe proves, inside the
   * server's serialized recovery boundary, exactly which fenced message
   * ids are settled; only those fences clear. Anything less (older server,
   * missing probe, readback failure) keeps the fences fail-closed.
   * Idempotent and replayable: runs on startup/rebind and on the per-chat
   * retry loop.
   */
  async reconcileReplayFencesWithServer(): Promise<void> {
    if (!this.replayFence || this.replayFenceUnavailable) return;
    const chatIds = [...new Set(this.replayFence.snapshot().map((entry) => entry.chatId))];
    for (const chatId of chatIds) {
      await this.reconcileReplayFenceForChat(chatId);
      this.ensureReplayFenceReconcileLoop(chatId, { immediate: false });
    }
  }

  /**
   * Fence keys the server has authoritatively proven settled. Once a key
   * lands here its settlement fact cannot be revoked by later tail traffic;
   * the retry loop only needs to redo the LOCAL clear, not the readback.
   */
  private readonly provenSettledFences = new Map<string, Set<string>>();
  /** Per-chat retry timers for the reconciliation/clear loop. */
  private readonly replayFenceRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private async reconcileReplayFenceForChat(chatId: string): Promise<void> {
    if (!this.replayFence || this.replayFenceUnavailable || !this.config.probeFencedSettlement) return;
    const probe = this.config.probeFencedSettlement;
    const fencedMessageIds = [
      ...new Set(
        this.replayFence
          .snapshot()
          .filter((entry) => entry.chatId === chatId)
          .map((entry) => entry.messageId),
      ),
    ];
    if (fencedMessageIds.length === 0) return;
    // Probe in wire-sized chunks: oversized frames are rejected outright
    // and would fail-closed forever. Settlement proof is merged ONLY when
    // every chunk succeeds — a rejected/timed-out chunk discards the whole
    // round and keeps every fence (fail-closed).
    const settled = new Set<string>();
    for (let offset = 0; offset < fencedMessageIds.length; offset += INBOX_FENCE_PROBE_MAX_IDS) {
      const chunk = fencedMessageIds.slice(offset, offset + INBOX_FENCE_PROBE_MAX_IDS);
      let settledIds: readonly string[];
      try {
        settledIds = await probe(chatId, chunk);
      } catch (err) {
        this.config.log.warn(
          { err, chatId, chunkOffset: offset },
          "replay fence settlement probe failed; discarding this round and keeping every fence (fail-closed)",
        );
        return;
      }
      // Only ids from THIS chunk may prove settlement; anything else is a
      // protocol violation and must not clear anything.
      const requested = new Set(chunk);
      for (const id of settledIds) {
        if (requested.has(id)) settled.add(id);
        else {
          this.config.log.warn({ chatId, id }, "fence probe returned an id outside the request chunk; ignoring it");
        }
      }
    }
    const proven = this.provenSettledFences.get(chatId) ?? new Set<string>();
    for (const messageId of fencedMessageIds) {
      if (settled.has(messageId)) proven.add(messageId);
    }
    if (proven.size > 0) {
      this.provenSettledFences.set(chatId, proven);
      await this.clearProvenSettledFences(chatId);
    }
  }

  /**
   * Clear every server-proven-settled fence for the chat, retrying local
   * I/O failures through the loop. When the last fence goes, withheld
   * deliveries re-enter routing and the chat's runtime projection recovers.
   */
  private async clearProvenSettledFences(chatId: string): Promise<void> {
    if (!this.replayFence) return;
    const proven = this.provenSettledFences.get(chatId);
    if (!proven) return;
    const clearedMessageIds: string[] = [];
    for (const messageId of [...proven]) {
      try {
        this.replayFence.clear(chatId, messageId);
        proven.delete(messageId);
        clearedMessageIds.push(messageId);
        this.config.log.info(
          { chatId, messageId },
          "cleared stale replay fence: delivery confirmed settled server-side",
        );
      } catch (err) {
        this.config.log.error(
          { err, chatId, messageId },
          "stale replay fence could not be cleared; the retry loop will redo the local clear",
        );
        this.config.onSessionRuntimeChange?.(chatId, "error");
      }
    }
    if (proven.size === 0) this.provenSettledFences.delete(chatId);
    if (clearedMessageIds.length > 0) this.inboxDelivery.settleReplayFencedEntries(chatId, clearedMessageIds);
    if (this.replayFence.hasFenceForChat(chatId)) return;
    await this.onChatFencesCleared(chatId);
  }

  /**
   * The single convergence point for "the last replay fence of a chat is
   * gone" — reached from the probe loop, the committed-ACK callback, and
   * local clear retries. Stops the retry loop and fires ONE destructive
   * recovery so the server resets and redelivers only the still-unacked
   * tail; the coordinator re-admits fence-withheld entries instead of
   * deduplicating them. Already-settled heads are never re-driven.
   */
  private async onChatFencesCleared(chatId: string): Promise<void> {
    this.stopReplayFenceReconcileLoop(chatId);
    if (this.config.recoverChat && this.inboxDelivery.hasUnsettledWork(chatId)) {
      this.beginPostFenceRecovery(chatId);
      return;
    }
    this.projectSessionRuntime(chatId);
  }

  /** Chats whose post-fence-clear recovery has not yet succeeded. */
  private readonly postFenceRecoveryDebt = new Set<string>();
  private readonly postFenceRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly postFenceRecoveryInFlight = new Map<string, Promise<void>>();

  /**
   * Fire the ONE successful destructive recovery that redelivers the
   * withheld tail after a fence clear, coalescing concurrent convergences
   * and retrying failures on a timer (failures hold new admissions via the
   * post-fence debt gate; retries are not duplicate successes).
   */
  private beginPostFenceRecovery(chatId: string): void {
    if (this.shuttingDown || !this.config.recoverChat) return;
    if (this.postFenceRecoveryInFlight.has(chatId) || this.postFenceRecoveryTimers.has(chatId)) return;
    this.postFenceRecoveryDebt.add(chatId);
    const recoverChat = this.config.recoverChat;
    const inFlight = (async () => {
      try {
        await recoverChat(chatId);
        this.postFenceRecoveryDebt.delete(chatId);
        this.config.log.info({ chatId }, "post-fence-clear recovery accepted; redelivery may proceed");
      } catch (err) {
        this.config.log.warn({ err, chatId }, "post-fence-clear recovery failed; retrying on a timer");
        this.armPostFenceRecoveryTimer(chatId);
      } finally {
        this.postFenceRecoveryInFlight.delete(chatId);
        this.projectSessionRuntime(chatId);
      }
    })();
    this.postFenceRecoveryInFlight.set(chatId, inFlight);
    void inFlight.catch(() => {});
  }

  private armPostFenceRecoveryTimer(chatId: string): void {
    if (this.shuttingDown) return;
    const timer = setTimeout(() => {
      this.postFenceRecoveryTimers.delete(chatId);
      this.beginPostFenceRecovery(chatId);
    }, REPLAY_FENCE_RECONCILE_INTERVAL_MS);
    this.postFenceRecoveryTimers.set(chatId, timer);
  }

  /**
   * Start (or keep) the per-chat retry loop. The timer fires on its own —
   * no dependence on another dispatch — and alternates between retrying
   * local clears of server-proven fences and re-reading server truth.
   */
  private ensureReplayFenceReconcileLoop(chatId: string, opts: { immediate?: boolean } = {}): void {
    if (this.shuttingDown) return;
    if (this.replayFenceRetryTimers.has(chatId)) return;
    if (opts.immediate !== false) {
      void this.reconcileReplayFenceForChat(chatId).catch((err) => {
        this.config.log.warn({ err, chatId }, "replay fence reconciliation attempt failed");
      });
    }
    this.armReplayFenceRetryTimer(chatId);
  }

  private armReplayFenceRetryTimer(chatId: string): void {
    const timer = setTimeout(() => {
      this.replayFenceRetryTimers.delete(chatId);
      void this.runReplayFenceReconcileLoop(chatId);
    }, REPLAY_FENCE_RECONCILE_INTERVAL_MS);
    this.replayFenceRetryTimers.set(chatId, timer);
  }

  private async runReplayFenceReconcileLoop(chatId: string): Promise<void> {
    if (this.shuttingDown || !this.replayFence) return;
    try {
      if ((this.provenSettledFences.get(chatId)?.size ?? 0) > 0) {
        await this.clearProvenSettledFences(chatId);
      } else {
        await this.reconcileReplayFenceForChat(chatId);
      }
    } catch (err) {
      this.config.log.warn({ err, chatId }, "replay fence reconciliation loop iteration failed");
    }
    if (!this.shuttingDown && this.replayFence.hasFenceForChat(chatId)) {
      this.armReplayFenceRetryTimer(chatId);
    }
  }

  private stopReplayFenceReconcileLoop(chatId: string): void {
    const timer = this.replayFenceRetryTimers.get(chatId);
    if (timer) clearTimeout(timer);
    this.replayFenceRetryTimers.delete(chatId);
    this.provenSettledFences.delete(chatId);
  }

  private isChatReplayFenced(chatId: string): boolean {
    if (this.replayFenceUnavailable) return true;
    if (!this.replayFence) return false;
    return this.replayFence.hasFenceForChat(chatId);
  }

  /**
   * Clear replay fences for deliveries whose ACK committed — including the
   * recovery/redelivery retry path, which never passes through the handler's
   * own completion cleanup. A clear that fails to persist leaves the chat
   * fenced; make that loudly operator-visible instead of a silent stall.
   */
  private reconcileReplayFences(chatId: string, messageIds: readonly string[]): void {
    if (!this.replayFence) return;
    const replayFence = this.replayFence;
    // Converge only on a real fence transition: an ordinary never-fenced
    // turn must never fire a post-fence recovery.
    let transitioned = false;
    const fencedMessageIds = messageIds.filter((messageId) => replayFence.isFenced(chatId, messageId));
    if (fencedMessageIds.length > 0) {
      // Invariant: authoritative settlement marker BEFORE any local fence
      // clear. The ACK is already server-confirmed, so the marker must
      // survive even if the clear below fails on I/O.
      this.inboxDelivery.markFenceSettled(chatId, fencedMessageIds);
    }
    for (const messageId of messageIds) {
      if (!this.replayFence.isFenced(chatId, messageId)) continue;
      transitioned = true;
      try {
        this.replayFence.clear(chatId, messageId);
      } catch (err) {
        // The ACK is already confirmed server-side, so this key is proven
        // settled; the retry loop redoes only the local clear.
        const proven = this.provenSettledFences.get(chatId) ?? new Set<string>();
        proven.add(messageId);
        this.provenSettledFences.set(chatId, proven);
        this.ensureReplayFenceReconcileLoop(chatId, { immediate: false });
        this.config.log.error(
          { err, chatId, messageId },
          "replay fence could not be cleared after confirmed ACK; the retry loop will redo the local clear",
        );
        this.config.onSessionRuntimeChange?.(chatId, "error");
      }
    }
    if (transitioned && !this.replayFence.hasFenceForChat(chatId)) {
      void this.onChatFencesCleared(chatId).catch((err) => {
        this.config.log.warn({ err, chatId }, "post-fence-clear convergence failed");
      });
    }
  }

  private createHandler(): AgentHandler {
    const handlerCfg = {
      ...this.config.handlerConfig,
      ...(this.config.agentConfigCache ? { agentConfigCache: this.config.agentConfigCache } : {}),
      ...(this.replayFence ? { replayFence: this.replayFence } : {}),
    };
    return this.config.handlerFactory(handlerCfg);
  }

  private handlerForRouteTransition(entry: SessionEntry): AgentHandler {
    if (!this.retiredHandlers.has(entry.handler)) return entry.handler;
    const previous = entry.handler;
    const handler = this.createHandler();
    entry.handler = handler;
    // The retired handler's shutdown was fire-and-forget — never confirmed.
    // Record the debt so a ref'd terminate strictly confirms the stop before
    // it may ack (the join resolves immediately when the stop already
    // confirmed, dropping the debt right away). Skip entirely when the stop
    // was already confirmed by the suspend boundary — a confirmed-stopped
    // handler is not debt.
    if (entry.handlerStoppedBySuspend !== previous) {
      this.detachHandlerWithPendingTeardown(entry.chatId, previous, "handler_replaced_after_retire");
    }
    return handler;
  }

  private beginRouteTransition(
    entry: SessionEntry,
    handler: AgentHandler,
    phase: RouteTransitionToken["phase"],
  ): RouteTransitionToken {
    entry.routeTransitionGeneration++;
    entry.routeInjectReady = false;
    const transition = { generation: entry.routeTransitionGeneration, handler, phase };
    entry.routeTransition = transition;
    return transition;
  }

  private isCurrentRouteTransition(entry: SessionEntry, transition: RouteTransitionToken): boolean {
    return entry.routeTransition === transition && this.isRouteAdoptionValid(entry, transition);
  }

  /** Shared identity checks for delivery-route leases (generation/handler/entry). */
  private isDeliveryRouteIdentityValid(entry: SessionEntry, transition: RouteLeaseToken): boolean {
    return (
      this.sessions.get(entry.chatId) === entry &&
      entry.routeTransitionGeneration === transition.generation &&
      entry.handler === transition.handler &&
      !this.retiredHandlers.has(transition.handler)
    );
  }

  /**
   * Active mutation/adoption fence for SessionContext and route receipt adoption.
   * Requires a live active slot and fails closed on manager shutdown. Manual
   * operator suspend releases the slot immediately — ordinary mutations must
   * not reopen through the settlement-only `suspended && suspending` window.
   */
  private isRouteAdoptionValid(entry: SessionEntry, transition: RouteLeaseToken): boolean {
    return (
      !this.shuttingDown &&
      this.isDeliveryRouteIdentityValid(entry, transition) &&
      entry.status === "active" &&
      entry.activeSlotHeld
    );
  }

  /**
   * Lease for already-issued DeliveryToken notice+ACK during graceful drain.
   * Ignores `shuttingDown` and additionally accepts the operator-suspend window
   * (`suspended && suspending`) so provider-entered custody can still settle.
   * Must not be used for ordinary SessionContext mutations.
   */
  private isDeliverySettlementLeaseValid(entry: SessionEntry, transition: RouteLeaseToken): boolean {
    const leaseHolder =
      (entry.status === "active" && entry.activeSlotHeld) ||
      (entry.status === "suspended" && entry.suspending !== null);
    return this.isDeliveryRouteIdentityValid(entry, transition) && leaseHolder;
  }

  private completeRouteTransition(entry: SessionEntry, transition: RouteTransitionToken): boolean {
    if (!this.isCurrentRouteTransition(entry, transition)) return false;
    entry.routeTransition = null;
    entry.routeInjectReady = false;
    return true;
  }

  private shutdownHandler(
    handler: AgentHandler,
    reason: string,
    opts: { afterPrior?: boolean; observeFailure?: boolean; settleProviderEntered?: boolean } = {},
  ): Promise<void> {
    const prior = this.handlerShutdowns.get(handler);
    // Joining a prior shutdown must not hide its failure from a strict
    // caller: `observeFailure` joins `raw`, lenient callers join `observed`.
    if (prior && opts.afterPrior !== true) return opts.observeFailure ? prior.raw : prior.observed;
    const raw = (prior?.observed ?? Promise.resolve()).then(() =>
      handler.shutdown(reason, {
        ...(opts.settleProviderEntered === true ? { settleProviderEntered: true } : {}),
      }),
    );
    // `observed` keeps the legacy swallow-and-warn semantics for
    // fire-and-forget callers; an `observeFailure` caller gets `raw` so a
    // teardown failure can fail its operation (Reset terminate apply-ack).
    // `raw`'s rejection is always handled by `observed`.
    const observed = raw.catch((err) => {
      this.config.log.warn({ reason, err }, "handler shutdown failed");
    });
    const record = { raw, observed };
    this.handlerShutdowns.set(handler, record);
    void observed.finally(() => {
      if (this.handlerShutdowns.get(handler) === record) this.handlerShutdowns.delete(handler);
    });
    return opts.observeFailure ? raw : observed;
  }

  /** Record a detached, unconfirmed-stop handler as teardown debt for the chat. */
  private registerPendingTeardown(chatId: string, handler: AgentHandler): void {
    let set = this.pendingTeardowns.get(chatId);
    if (!set) {
      set = new Set();
      this.pendingTeardowns.set(chatId, set);
    }
    set.add(handler);
  }

  private dropPendingTeardown(chatId: string, handler: AgentHandler): void {
    const set = this.pendingTeardowns.get(chatId);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this.pendingTeardowns.delete(chatId);
  }

  /**
   * Register an in-flight route producer (the provider start/resume call of
   * a route transition). Returns the settle callback; the tracked promise
   * never rejects, so joining it is always safe.
   */
  private registerRouteProducer(chatId: string): () => void {
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    let set = this.routeProducers.get(chatId);
    if (!set) {
      set = new Set();
      this.routeProducers.set(chatId, set);
    }
    set.add(promise);
    return () => {
      resolvePromise();
      const current = this.routeProducers.get(chatId);
      if (!current) return;
      current.delete(promise);
      if (current.size === 0) this.routeProducers.delete(chatId);
    };
  }

  /**
   * Join every in-flight route producer for the chat, draining to a stable
   * quiet point. A producer's settle can reveal late materialization debt
   * (via `discardStaleRouteTransition`), so callers must run the debt drain
   * AFTER this returns.
   */
  private async quiesceRouteProducers(chatId: string): Promise<void> {
    for (;;) {
      const producers = this.routeProducers.get(chatId);
      if (!producers || producers.size === 0) return;
      await Promise.allSettled([...producers]);
    }
  }

  /**
   * Route admission fence: before a chat may create a new provider route,
   * its teardown authority must be clean — otherwise the chat could run
   * "old handler never confirmed stopped + new provider route started".
   * Settles every pending handler strictly (coalescing joins in-flight
   * shutdowns). Returns false when a stop fails: the debt stays registered
   * and the caller must keep the delivery's recovery/retry custody instead
   * of routing.
   */
  private async settleTeardownDebtBeforeRoute(chatId: string): Promise<boolean> {
    // Quiesce in-flight route producers FIRST: a canceled start/resume can
    // still materialize late, and its discard registers teardown debt only
    // when the producer settles — debt drained before this point would be
    // incomplete, and a fresh route started over an unquiesced producer
    // could race the late materialization. (Guarded so the common no-
    // producer case adds no extra awaits to the route hot path.)
    if ((this.routeProducers.get(chatId)?.size ?? 0) > 0) {
      await this.quiesceRouteProducers(chatId);
    }
    for (;;) {
      const pending = this.pendingTeardowns.get(chatId);
      if (!pending || pending.size === 0) return true;
      let settled = true;
      for (const pendingHandler of [...pending]) {
        try {
          await this.shutdownHandler(pendingHandler, "route_admission_teardown", { observeFailure: true });
          this.dropPendingTeardown(chatId, pendingHandler);
        } catch (err) {
          this.config.log.warn({ chatId, err }, "route admission teardown failed; keeping recovery custody");
          settled = false;
        }
      }
      if (!settled) return false;
    }
  }

  /**
   * Detach a handler whose stop is not yet confirmed. Keeps the calling
   * path's existing fire-and-forget shutdown semantics (lenient observed
   * face still logs failures), but records the debt so a later ref'd
   * terminate strictly confirms the stop. The raw face drives
   * deregistration — a failed shutdown keeps the debt, so the terminate
   * retry loop converges instead of acking over a live old run.
   */
  private detachHandlerWithPendingTeardown(chatId: string, handler: AgentHandler, reason: string): void {
    this.registerPendingTeardown(chatId, handler);
    void this.shutdownHandler(handler, reason, { observeFailure: true }).then(
      () => this.dropPendingTeardown(chatId, handler),
      () => {
        // Failure keeps the debt — a later ref'd terminate strictly retries.
      },
    );
  }

  private retireTransitionHandler(transition: RouteTransitionToken, reason: string): void {
    this.retiredHandlers.add(transition.handler);
    void this.shutdownHandler(transition.handler, reason);
  }

  private invalidateRouteTransition(entry: SessionEntry, reason: string): RouteTransitionToken | null {
    this.invalidateDeliveryAdmission(entry.chatId);
    const transition = entry.routeTransition;
    entry.routeTransitionGeneration++;
    entry.routeTransition = null;
    entry.routeInjectReady = false;
    if (transition) this.retireTransitionHandler(transition, reason);
    return transition;
  }

  private discardStaleRouteTransition(chatId: string, transition: RouteTransitionToken, reason: string): void {
    this.retiredHandlers.add(transition.handler);
    // A stale route completion MATERIALIZES the handler (the canceled
    // start/resume returned late), so it needs a NEW shutdown chained after
    // any prior (a pre-materialization shutdown was a no-op). That stop's
    // outcome enters the pending-teardown authority: on failure the
    // possibly-live stale handler stays joinable for a ref'd terminate /
    // reconcile retry / manager shutdown instead of becoming ownerless.
    this.registerPendingTeardown(chatId, transition.handler);
    void this.shutdownHandler(transition.handler, reason, { afterPrior: true, observeFailure: true }).then(
      () => this.dropPendingTeardown(chatId, transition.handler),
      () => {
        // Failure keeps the debt — a later terminate / reconcile retries it.
      },
    );
  }

  private claimActiveSlot(entry: SessionEntry): void {
    if (entry.activeSlotHeld) return;
    entry.activeSlotHeld = true;
    this._activeCount++;
  }

  private releaseActiveSlot(entry: SessionEntry): boolean {
    if (!entry.activeSlotHeld) return false;
    entry.activeSlotHeld = false;
    this._activeCount = Math.max(0, this._activeCount - 1);
    return true;
  }

  private runtimeProvider(): RuntimeProvider {
    const parsed = runtimeProviderSchema.safeParse(this.config.handlerConfig.runtimeProvider);
    return parsed.success ? parsed.data : "claude-code";
  }

  private captureRuntimeFailureNotice(
    chatId: string,
    event: SessionEvent,
    mutationLeaseValid: (() => boolean) | null = null,
    expectedEntry: SessionEntry | null = null,
  ): boolean {
    if (mutationLeaseValid && !mutationLeaseValid()) return false;
    if (event.kind !== "error") return false;
    const payload = parseProviderRetryEventMessage(event.payload.message);
    if (!payload || (!shouldPostProviderFailureRuntimeNotice(payload) && !isRuntimeSessionProofFailure(payload))) {
      return false;
    }

    const entry = this.sessions.get(chatId);
    if (!entry) return false;
    if (expectedEntry && entry !== expectedEntry) return false;
    if (mutationLeaseValid && !mutationLeaseValid()) return false;
    entry.pendingRuntimeFailureNotice = payload;
    return true;
  }

  private emitSessionEvent(chatId: string, event: SessionEvent, expectedEntry: SessionEntry | null = null): void {
    this.config.onSessionEvent?.(chatId, event);
    const mutationLeaseValid = expectedEntry ? () => this.sessions.get(chatId) === expectedEntry : null;
    this.captureRuntimeFailureNotice(chatId, event, mutationLeaseValid, expectedEntry);
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
    // Preserve the captured terminal notice on the inbox ledger before clearing
    // session-scoped pending state. Recovery/redelivery must retry that notice
    // before any ACK — never treat a notice-failure marker as ACK-eligible.
    if (reason === "runtime_failure_notice_delivery_failed") {
      const pending = this.sessions.get(chatId)?.pendingRuntimeFailureNotice;
      if (pending && shouldPostProviderFailureRuntimeNotice(pending)) {
        this.inboxDelivery.markNoticeRequired(chatId, messages, pending);
      }
    }
    this.clearPendingRuntimeFailureNotice(chatId);
    this.inboxDelivery.retryTurn(chatId, messages, reason);
  }

  private pendingRuntimeSessionProofFailure(chatId: string): ProviderRetryEventPayload | null {
    const payload = this.sessions.get(chatId)?.pendingRuntimeFailureNotice;
    return payload && isRuntimeSessionProofFailure(payload) ? payload : null;
  }

  private runtimeSessionProofReasonForError(err: unknown): string | null {
    const classification = classifyProviderFailure(err, {
      provider: this.runtimeProvider(),
      scope: "provider_turn",
      source: "sdk",
    });
    return classification.category === "runtime_transport" ? classification.reasonCode : null;
  }

  private async holdDeliveryForRuntimeSessionProofRecovery(
    chatId: string,
    messages: SessionMessage | readonly SessionMessage[],
    reasonCode?: string,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<boolean> {
    const entry = this.sessions.get(chatId);
    const payload = entry?.pendingRuntimeFailureNotice;
    const proofReason = reasonCode ?? (payload && isRuntimeSessionProofFailure(payload) ? payload.reasonCode : null);
    if (!proofReason) return false;
    if (mutationLeaseValid && !mutationLeaseValid()) return false;

    const held = await this.inboxDelivery.parkTurnForDeferredRecovery(
      chatId,
      messages,
      `runtime_session_proof:${proofReason}`,
    );
    if (!held) return false;

    if (entry && payload && this.sessions.get(chatId) === entry && entry.pendingRuntimeFailureNotice === payload) {
      entry.pendingRuntimeFailureNotice = null;
    }
    this.runtimeProofRecoveryChats.add(chatId);
    if (entry) this.fenceSessionForRuntimeSessionProofRecovery(chatId, proofReason);
    this.projectSessionRuntime(chatId);

    const recover = this.config.recoverRuntimeSessionProof;
    if (!recover) {
      this.config.log.error(
        { chatId, reasonCode: proofReason },
        "runtime-session proof recovery is required but no rebind callback is configured",
      );
      return true;
    }
    void recover(proofReason).catch((err) => {
      this.config.log.warn(
        { chatId, reasonCode: proofReason, err },
        "runtime-session proof rebind failed; inbox debt remains held",
      );
    });
    return true;
  }

  private fenceSessionForRuntimeSessionProofRecovery(chatId: string, reasonCode: string): void {
    const entry = this.sessions.get(chatId);
    if (!entry) return;
    const reason = `runtime_session_proof:${reasonCode}`;
    this.invalidateRouteTransition(entry, reason);
    this.clearRetryState(entry);
    const resumeSessionId = resumableProviderSessionId(entry.claudeSessionId, entry.retryFromEvicted?.claudeSessionId);
    if (resumeSessionId) {
      this.addEvictedMapping(chatId, {
        claudeSessionId: resumeSessionId,
        lastActivity: entry.lastActivity,
      });
    }
    this.releaseActiveSlot(entry);
    void this.shutdownHandler(entry.handler, reason);
    this.sessions.delete(chatId);
    this.sessionRuntimeStates.delete(chatId);
    this.currentTrigger.delete(chatId);
    this.notifySessionState(chatId, "errored");
    this.config.log.warn(
      { chatId, reasonCode },
      "session fenced until a fresh runtime-session bind restores HTTP proof",
    );
    this.recomputeRuntimeState();
    this.persistRegistry();
    this.drainPendingQueue();
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

  private async postPendingRuntimeFailureNotice(
    chatId: string,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<RuntimeFailureNoticePostResult> {
    const entry = this.sessions.get(chatId);
    const payload = entry?.pendingRuntimeFailureNotice;
    if (!entry || !payload) return { kind: "posted" };

    try {
      await postProviderFailureRuntimeNotice(this.config.sdk, chatId, payload);
      if (mutationLeaseValid && !mutationLeaseValid()) return { kind: "posted" };
      if (this.sessions.get(chatId) === entry && entry.pendingRuntimeFailureNotice === payload) {
        entry.pendingRuntimeFailureNotice = null;
      }
      return { kind: "posted" };
    } catch (err) {
      if (mutationLeaseValid && !mutationLeaseValid()) return { kind: "failed" };
      if (this.sessions.get(chatId) !== entry || entry.pendingRuntimeFailureNotice !== payload) {
        return { kind: "failed" };
      }
      const noticeFailure = classifyProviderFailure(err, {
        provider: payload.provider,
        scope: payload.scope,
        source: "sdk",
      });
      if (noticeFailure.category === "runtime_transport") {
        this.config.log.warn(
          { chatId, err, reasonCode: noticeFailure.reasonCode },
          "runtime failure notice hit stale runtime-session proof; deferring to rebind",
        );
        return { kind: "runtime_session_proof", reasonCode: noticeFailure.reasonCode };
      }
      this.config.log.warn({ chatId, err, reasonCode: payload.reasonCode }, "runtime failure notice delivery failed");
      this.emitRuntimeFailureNoticeDeliveryFailure(chatId, err);
      return { kind: "failed" };
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

    this.invalidateRouteTransition(entry, reason);
    this.clearRetryState(entry);
    const resumeSessionId = resumableProviderSessionId(
      sessionId,
      entry.claudeSessionId,
      entry.retryFromEvicted?.claudeSessionId,
    );
    if (resumeSessionId) {
      this.addEvictedMapping(chatId, {
        claudeSessionId: resumeSessionId,
        lastActivity: entry.lastActivity,
      });
    }
    this.releaseActiveSlot(entry);
    this.detachHandlerWithPendingTeardown(chatId, entry.handler, reason);

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
    this.invalidateRouteTransition(entry, reason);
    this.releaseActiveSlot(entry);
    this.detachHandlerWithPendingTeardown(chatId, entry.handler, reason);
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
    deliveryLeaseValid: (() => boolean) | null = null,
  ): Promise<DeliveryCompletionDisposition> {
    if (deliveryLeaseValid && !deliveryLeaseValid()) return "retry";
    if (
      outcome.status === "error" &&
      this.pendingRuntimeSessionProofFailure(chatId) &&
      (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, messages, undefined, deliveryLeaseValid))
    ) {
      // Held for bind recovery: server custody is deliberately retained
      // (unacked, no same-socket recovery), so report "retry" rather than
      // "settled" to the handler's completion bookkeeping.
      return "retry";
    }
    const retryReason = this.errorCompletionRetryReason(outcome);
    if (retryReason) {
      this.warnRejectedErrorCompletion(chatId, outcome, retryReason);
      this.retryDeliveryTurn(chatId, messages, retryReason);
      this.projectSessionRuntime(chatId);
      return "retry";
    }
    if (outcome.status === "success") {
      this.clearPendingRuntimeFailureNotice(chatId);
    } else if (outcome.completion === "consumed") {
      const noticeResult = await this.postPendingRuntimeFailureNotice(chatId, deliveryLeaseValid);
      if (deliveryLeaseValid && !deliveryLeaseValid()) return "retry";
      if (noticeResult.kind === "runtime_session_proof") {
        const held = await this.holdDeliveryForRuntimeSessionProofRecovery(
          chatId,
          messages,
          noticeResult.reasonCode,
          deliveryLeaseValid,
        );
        if (held) return "retry";
        this.retryDeliveryTurn(chatId, messages, "runtime_session_proof_hold_failed");
        this.projectSessionRuntime(chatId);
        return "retry";
      }
      if (noticeResult.kind === "failed") {
        this.retryDeliveryTurn(chatId, messages, "runtime_failure_notice_delivery_failed");
        this.projectSessionRuntime(chatId);
        return "retry";
      }
    }
    if (deliveryLeaseValid && !deliveryLeaseValid()) return "retry";
    // The coordinator reports "settled" only once the concrete entries left
    // the ledger through a confirmed ACK; recovery debt, prefix gaps, and
    // ACK rejections keep custody and surface as "retry".
    const disposition = await this.inboxDelivery.finishTurn(chatId, messages, outcome);
    this.projectSessionRuntime(chatId);
    return disposition;
  }

  private createDeliveryToken(
    chatId: string,
    lease:
      | (() => boolean)
      | {
          mutationValid: () => boolean;
          settlementValid: () => boolean;
        }
      | null = null,
  ): DeliveryToken {
    let terminalReported = false;
    const mutationValid = () => (typeof lease === "function" ? lease() : (lease?.mutationValid() ?? true));
    const settlementValid = () => (typeof lease === "function" ? lease() : (lease?.settlementValid() ?? true));
    const claimTerminal = (action: string): boolean => {
      if (!settlementValid()) {
        this.config.log.debug({ chatId, action }, "delivery token outcome ignored after route invalidation");
        return false;
      }
      if (!terminalReported) {
        terminalReported = true;
        return true;
      }
      this.config.log.warn({ chatId, action }, "delivery token terminal outcome ignored after prior outcome");
      return false;
    };
    return {
      processingStarted: (messages) => {
        // Processing-start is a route mutation — fenced by shuttingDown.
        if (terminalReported || !mutationValid()) return;
        this.inboxDelivery.markProcessingStarted(chatId, messages);
        this.projectSessionRuntime(chatId);
        // Head membership proof: open live inject for same-chat tails that
        // arrived while start/resume still owns routeTransition (e.g. Pi
        // awaiting agent_settled). Pre-proof FIFO stays deferred until here.
        this.markRouteInjectReady(chatId);
      },
      complete: async (messages, outcome) => {
        if (!claimTerminal("complete")) return "retry";
        return await this.completeDeliveryTurn(chatId, messages, outcome, settlementValid);
      },
      retry: (messages, reason) => {
        if (!claimTerminal("retry")) return;
        this.retryDeliveryTurn(chatId, messages, reason);
        this.projectSessionRuntime(chatId);
      },
      terminalRejected: async (messages, reason, evidence) => {
        if (!claimTerminal("terminalRejected")) return;
        if (
          this.pendingRuntimeSessionProofFailure(chatId) &&
          (await this.holdDeliveryForRuntimeSessionProofRecovery(chatId, messages, undefined, settlementValid))
        ) {
          return;
        }
        const noticeResult = await this.postPendingRuntimeFailureNotice(chatId, settlementValid);
        if (!settlementValid()) return;
        if (noticeResult.kind === "runtime_session_proof") {
          const held = await this.holdDeliveryForRuntimeSessionProofRecovery(
            chatId,
            messages,
            noticeResult.reasonCode,
            settlementValid,
          );
          if (held) return;
          this.retryDeliveryTurn(chatId, messages, "runtime_session_proof_hold_failed");
          this.projectSessionRuntime(chatId);
          return;
        }
        if (noticeResult.kind === "failed") {
          this.retryDeliveryTurn(chatId, messages, "runtime_failure_notice_delivery_failed");
          this.projectSessionRuntime(chatId);
          return;
        }
        await this.inboxDelivery.terminalRejected(chatId, messages, reason, evidence);
        this.projectSessionRuntime(chatId);
      },
    };
  }

  private createDeliveryAttempt(
    chatId: string,
    leases: {
      mutationValid: () => boolean;
      settlementValid: () => boolean;
    },
  ): {
    token: DeliveryToken;
    cancel(): void;
  } {
    let active = true;
    // Attempt cancellation revokes both leases. Mutation stays adoption-gated;
    // settlement keeps the narrow operator-suspend / full-drain window so an
    // already-issued inject token can still post notice+ACK after the active
    // slot is released.
    return {
      token: this.createDeliveryToken(chatId, {
        mutationValid: () => active && leases.mutationValid(),
        settlementValid: () => active && leases.settlementValid(),
      }),
      cancel: () => {
        active = false;
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

  private adoptResumeReceipt(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    receipt: ReturnType<typeof normalizeResumeReceipt>,
    abortReason: string,
  ): boolean {
    if (message) {
      const ownership = this.markRouteOwned(entry.chatId, message, normalizeRouteReceipt(receipt.route ?? undefined));
      if (ownership === "lost") {
        this.abortUnownedRoute(entry, abortReason);
        return false;
      }
    }
    entry.claudeSessionId = receipt.sessionId;
    return true;
  }

  private async routeMessage(
    chatId: string,
    message: SessionMessage,
    deliveryKind: SlotDeliveryKind = "fresh",
  ): Promise<void> {
    if (this.shuttingDown) {
      this.retryDeliveryTurn(chatId, message, "manager_shutdown");
      return;
    }
    if (this.isProviderRouteAdmissionFenced(chatId)) {
      // Race path: admission was valid earlier in dispatch but the fence
      // landed before route. Park without same-socket recovery — same policy
      // as the admissionValid fence branch above.
      await this.parkDeliveryBehindResetAdmissionFence(chatId, message);
      return;
    }
    if (this.isChatReplayFenced(chatId)) {
      // A previous provider turn in this chat produced a non-read-only tool
      // effect before an interruption and never settled. Re-entering the
      // provider for the fenced head would replay that effect, and inbox ACK
      // is prefix-based, so the chat's entire FIFO tail must hold behind it:
      // every delivery stays unacknowledged recovery debt until an operator
      // resolves the fenced head. The ledger entry is marked fence-withheld
      // (no custody taken) so a later post-clear server redelivery is
      // re-admitted instead of deduplicated.
      this.config.log.error(
        { chatId, messageId: message.id },
        "withholding provider re-entry for replay-fenced chat; unsafe tool effect fenced before interruption",
      );
      this.config.onSessionRuntimeChange?.(chatId, "error");
      this.inboxDelivery.markReplayFenceWithheld(chatId, [message.id]);
      this.ensureReplayFenceReconcileLoop(chatId);
      return;
    }
    if (this.postFenceRecoveryDebt.has(chatId)) {
      // A post-fence-clear recovery is in flight or being retried: hold
      // EVERY admission until one recovery is durably accepted. A
      // re-admitted duplicate only proves local withholding, never recovery
      // success, so it must not bypass the debt either — it is simply
      // re-marked and redelivered by the eventual accepted recovery.
      this.config.log.info(
        { chatId, messageId: message.id },
        "holding delivery while post-fence-clear recovery is pending",
      );
      this.inboxDelivery.markReplayFenceWithheld(chatId, [message.id]);
      return;
    }
    const existing = this.sessions.get(chatId);

    // A terminal decision closes route admission before its durable event is
    // confirmed. New delivery waits for teardown instead of reviving the same
    // SessionEntry while its original transition still owns the active slot.
    if (existing?.status === "errored") {
      this.queueForSlot(chatId, message, deliveryKind, "terminal_teardown_pending");
      return;
    }

    // Transient start/resume retries:
    // - Waiting/backoff (no live transition): keep the original head first and
    //   nudge the retry timer; do not open inject.
    // - Provider-entered retry transition (routeInjectReady): live-inject the
    //   same way as a first-attempt start/resume that still awaits settlement.
    //   retryAttempt stays nonzero until start/resume returns, so readiness
    //   must not be gated solely on that flag.
    if (existing && existing.retryAttempt > 0 && existing.routeTransition === null) {
      existing.deferredMessages.push(message);
      this.triggerImmediateRetry(chatId);
      return;
    }

    // An in-flight start/resume (including a winning retry attempt) keeps
    // routeTransition until the producer returns. Before the head proves
    // provider membership (processingStarted), same-chat tails stay
    // FIFO-deferred. After membership is proven, live inject is allowed even
    // while the producer still awaits settlement — required for providers
    // such as Pi whose start/resume await agent_settled.
    if (existing && existing.routeTransition !== null) {
      if (existing.routeInjectReady && existing.status === "active") {
        this.injectIntoActiveRoute(existing, message);
        return;
      }
      existing.deferredMessages.push(message);
      return;
    }

    if (existing) {
      switch (existing.status) {
        case "active": {
          this.injectIntoActiveRoute(existing, message);
          return;
        }

        case "suspended":
        case "evicted":
          await this.resumeSession(existing, message, deliveryKind);
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
    if (this.shuttingDown) {
      this.retryDeliveryTurn(chatId, message, "manager_shutdown");
      return;
    }
    // Route admission fence: settle this chat's teardown authority before a
    // new provider route may be created — otherwise the chat could run "old
    // handler never confirmed stopped + new route started". On failure the
    // throw routes into the caller's existing retryDeliveryTurn path, so the
    // delivery keeps its recovery custody.
    if (!(await this.settleTeardownDebtBeforeRoute(chatId))) {
      throw new Error("route admission: teardown debt settle failed");
    }
    // The settle awaited: re-validate the fences — a terminate or manager
    // shutdown may have started meanwhile. A terminate owns the chat's
    // delivery state now (hold silently); a shutdown keeps the delivery in
    // retry custody.
    if (this.shuttingDown) {
      this.retryDeliveryTurn(chatId, message, "manager_shutdown");
      return;
    }
    // The settle awaited: a terminate may have started meanwhile — or a prior
    // Reset flush may have failed — either owns the chat's delivery state now,
    // so hold instead of installing a route.
    if (this.isProviderRouteAdmissionFenced(chatId)) return;
    // The settle also made the route selection stale: another path may have
    // created the session meanwhile. Re-dispatch through routeMessage's
    // selection instead of creating a duplicate entry (or overwriting one).
    if (this.sessions.has(chatId)) {
      await this.routeMessage(chatId, message, deliveryKind);
      return;
    }
    // Enforce max_sessions before active-slot preemption so a full pool of
    // working sessions queues instead of first suspending a working victim.
    if (!this.evictIfNeeded(chatId, message, deliveryKind)) return;

    // Enforce concurrency limit
    if (!this.acquireActiveSlot(chatId, message, deliveryKind)) return;

    // Check for prior evicted session mapping
    const storedEvicted = this.evictedMappings.get(chatId);
    const evictedSessionId = resumableProviderSessionId(storedEvicted?.claudeSessionId);
    const evicted =
      storedEvicted && evictedSessionId ? { ...storedEvicted, claudeSessionId: evictedSessionId } : undefined;
    if (storedEvicted && !evicted) this.evictedMappings.delete(chatId);

    // Step 6: thread the AgentConfigCache to the handler so it can read the
    // current per-agent runtime config when launching its sub-process.
    const handler = this.createHandler();

    const entry: SessionEntry = {
      chatId,
      claudeSessionId: evicted?.claudeSessionId ?? "",
      handler,
      status: "active",
      activeSlotHeld: false,
      lastActivity: Date.now(),
      suspending: null,
      suspendError: null,
      handlerStoppedBySuspend: null,
      teardownError: null,
      retryAttempt: 0,
      retryNextAt: null,
      retryTimer: null,
      lastRetryReason: null,
      lastRetryCategory: null,
      lastRetryScope: null,
      lastRetryRawError: null,
      retryHeadMessage: null,
      deferredMessages: [],
      routeTransitionGeneration: 0,
      routeTransition: null,
      routeInjectReady: false,
      pendingRuntimeFailureNotice: null,
      retryFromEvicted: evicted ?? null,
    };

    this.sessions.set(chatId, entry);
    this.claimActiveSlot(entry);
    const transition = this.beginRouteTransition(entry, handler, evicted ? "resume" : "start");
    const mutationValid = () => this.isRouteAdoptionValid(entry, transition);
    const settlementValid = () => this.isDeliverySettlementLeaseValid(entry, transition);
    const routeLeases = { mutationValid, settlementValid };
    const ctx = this.buildSessionContext(chatId, routeLeases);
    if (evicted) this.evictedMappings.delete(chatId);

    // Report `active` before runtime projection. `session:runtime` frames are
    // active-gated on the server, so the state row must exist before a fresh
    // delivery projects this chat to working.
    this.notifySessionState(chatId, "active");
    this.projectSessionRuntime(chatId, { drainPendingOnIdle: false });
    // Settle callback for the route producer, assigned as the FIRST
    // statement inside the try below: a throw before registration leaves no
    // producer behind, and everything after registration is covered by the
    // finally — so no throw can leave a producer that never settles.
    let settleRouteProducer: () => void = () => {};
    try {
      // Track the route producer from here until it settles: a canceled
      // start can still materialize late, and terminate / manager shutdown
      // join this before they may ack/return (see routeProducers).
      settleRouteProducer = this.registerRouteProducer(chatId);
      this.setCurrentTrigger(chatId, message);
      const token = this.createDeliveryToken(chatId, routeLeases);
      if (evicted) {
        const receipt = normalizeResumeReceipt(await handler.resume(message, evicted.claudeSessionId, ctx, token));
        if (!this.isCurrentRouteTransition(entry, transition)) {
          this.discardStaleRouteTransition(entry.chatId, transition, "session_eviction_resume_stale_completion");
          return;
        }
        if (!this.adoptResumeReceipt(entry, message, receipt, "session_eviction_resume_unowned_delivery")) return;
        this.config.log.info({ chatId, sessionId: entry.claudeSessionId }, "session resumed from eviction");
      } else {
        const receipt = normalizeStartReceipt(await handler.start(message, ctx, token));
        if (!this.isCurrentRouteTransition(entry, transition)) {
          this.discardStaleRouteTransition(entry.chatId, transition, "session_start_stale_completion");
          return;
        }
        entry.claudeSessionId = receipt.sessionId;
        if (this.markRouteOwned(chatId, message, receipt.route) === "lost") {
          this.abortUnownedRoute(entry, "session_start_unowned_delivery");
          return;
        }
        this.config.log.info({ chatId, sessionId: entry.claudeSessionId }, "session created");
      }
      if (!this.completeRouteTransition(entry, transition)) {
        this.discardStaleRouteTransition(entry.chatId, transition, "session_start_stale_adoption");
        return;
      }
      this.drainDeferredMessages(entry);
      this.persistRegistry();
    } catch (err) {
      if (!this.isCurrentRouteTransition(entry, transition)) {
        this.discardStaleRouteTransition(entry.chatId, transition, "session_start_stale_failure");
        return;
      }
      this.invalidateRouteTransition(entry, "session_start_failed");
      const phase: "start" | "resume" = evicted ? "resume" : "start";
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: phase === "start" ? "session_start" : "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        err,
        phase,
        classification,
        attemptedMessage: message,
      });
      if (this.sessions.get(chatId) !== entry) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, message, handling);
    } finally {
      settleRouteProducer();
    }
  }

  private async resumeSession(
    entry: SessionEntry,
    message: SessionMessage | null | undefined,
    deliveryKind: SlotDeliveryKind = "fresh",
  ): Promise<void> {
    const stopForManagerShutdown = (reason: string): boolean => {
      if (!this.shuttingDown) return false;
      if (message) this.retryDeliveryTurn(entry.chatId, message, reason);
      return true;
    };
    if (stopForManagerShutdown("session_resume:manager_shutdown")) return;
    // Wait for in-flight suspension to complete before resuming
    if (entry.suspending) {
      await entry.suspending;
    }
    if (stopForManagerShutdown("session_resume:manager_shutdown_after_suspend")) return;
    if (this.sessions.get(entry.chatId) !== entry) return;
    if (await this.recoverDebtBeforeResume(entry.chatId, "session_resume:recovery_debt")) return;
    if (stopForManagerShutdown("session_resume:manager_shutdown_after_recovery")) return;
    if (
      this.sessions.get(entry.chatId) !== entry ||
      (entry.status !== "suspended" && entry.status !== "evicted") ||
      entry.activeSlotHeld ||
      entry.routeTransition !== null
    ) {
      return;
    }

    // A failed suspend left the current handler never confirmed stopped.
    // Stop it strictly (joining any in-flight shutdown's raw face) BEFORE
    // the route below reuses or replaces the reference — reusing or
    // overwriting an unconfirmed-stop handler loses the teardown authority
    // while the old run may still be alive. A teardown failure propagates
    // into resume's existing error semantics (routeMessage retries the
    // delivery / operator resume logs the command error); it must not
    // silently continue. On success the handler is retired so the route
    // installs a fresh one, and the recorded suspend failure is cleared.
    if (entry.suspendError && entry.handlerStoppedBySuspend !== entry.handler) {
      await this.shutdownHandler(entry.handler, "session_resume_after_failed_suspend", { observeFailure: true });
      entry.handlerStoppedBySuspend = entry.handler;
      entry.suspendError = null;
      this.retiredHandlers.add(entry.handler);
    }

    // Route admission fence: settle this chat's teardown authority before
    // installing or reusing a handler — on failure the throw routes into the
    // caller's existing retryDeliveryTurn path, keeping recovery custody.
    if (!(await this.settleTeardownDebtBeforeRoute(entry.chatId))) {
      throw new Error("route admission: teardown debt settle failed");
    }
    // The settle awaited: re-validate the entry, then the terminate fence —
    // a terminate in flight for this chat may share the very shutdown this
    // resume just joined, and installing a fresh handler now would let that
    // terminate drain the OLD debt and ack while the NEW handler is still
    // running. Abort instead; the route callers treat the failure with
    // resume's existing error semantics (the terminate clears admission and
    // pending delivery state on its own).
    if (this.sessions.get(entry.chatId) !== entry) {
      // The entry was replaced while this resume waited — the new owner
      // routes the chat; keep the delivery in recovery custody.
      if (message) this.retryDeliveryTurn(entry.chatId, message, "resume_entry_replaced");
      return;
    }
    if (this.isProviderRouteAdmissionFenced(entry.chatId)) {
      throw new Error("session resume fenced: Reset retirement pending for chat");
    }
    // Full route-selection re-validation, acting as the CAS against
    // concurrent waiters: another dispatch may have won the route while
    // this resume awaited the settle. Its in-flight transition owns the
    // chat now — defer onto it (the winner drains deferredMessages) instead
    // of calling handler.resume twice. The checks below and the
    // beginRouteTransition install are synchronous, so exactly one waiter
    // can win.
    if (entry.routeTransition !== null) {
      if (message) entry.deferredMessages.push(message);
      return;
    }
    if (entry.activeSlotHeld || (entry.status !== "suspended" && entry.status !== "evicted")) {
      if (message) this.retryDeliveryTurn(entry.chatId, message, "resume_selection_stale");
      return;
    }

    // Admin-triggered resume has no provider input. It may use idle capacity,
    // but it must not preempt unrelated working turns.
    const slotKind: SlotDeliveryKind = message ? deliveryKind : "control";
    if (!this.acquireActiveSlot(entry.chatId, message ?? null, slotKind)) return;
    if (stopForManagerShutdown("session_resume:manager_shutdown_after_slot")) return;

    const routeHandler = this.handlerForRouteTransition(entry);
    entry.status = "active";
    this.claimActiveSlot(entry);
    const transition = this.beginRouteTransition(entry, routeHandler, "resume");
    const mutationValid = () => this.isRouteAdoptionValid(entry, transition);
    const settlementValid = () => this.isDeliverySettlementLeaseValid(entry, transition);
    const routeLeases = { mutationValid, settlementValid };
    const ctx = this.buildSessionContext(entry.chatId, routeLeases);
    entry.lastActivity = Date.now();

    this.notifySessionState(entry.chatId, "active");
    this.projectSessionRuntime(entry.chatId, { drainPendingOnIdle: false });
    // Settle callback for the route producer, assigned as the FIRST
    // statement inside the try below: a throw before registration leaves no
    // producer behind, and everything after registration is covered by the
    // finally — so no throw can leave a producer that never settles.
    let settleRouteProducer: () => void = () => {};
    try {
      // Track the route producer: a canceled resume can still materialize
      // late, and terminate / manager shutdown join this before ack/return.
      settleRouteProducer = this.registerRouteProducer(entry.chatId);
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
      const token = message ? this.createDeliveryToken(entry.chatId, routeLeases) : undefined;
      const resumeResult = token
        ? await routeHandler.resume(message ?? undefined, entry.claudeSessionId, ctx, token)
        : await routeHandler.resume(message ?? undefined, entry.claudeSessionId, ctx);
      if (!this.isCurrentRouteTransition(entry, transition)) {
        this.discardStaleRouteTransition(entry.chatId, transition, "session_resume_stale_completion");
        return;
      }
      const receipt = normalizeResumeReceipt(resumeResult);
      if (!this.adoptResumeReceipt(entry, message, receipt, "session_resume_unowned_delivery")) return;
      if (!this.completeRouteTransition(entry, transition)) {
        this.discardStaleRouteTransition(entry.chatId, transition, "session_resume_stale_adoption");
        return;
      }
      this.drainDeferredMessages(entry);
      this.config.log.info({ chatId: entry.chatId, sessionId: entry.claudeSessionId }, "session resumed");
      this.persistRegistry();
    } catch (err) {
      if (!this.isCurrentRouteTransition(entry, transition)) {
        this.discardStaleRouteTransition(entry.chatId, transition, "session_resume_stale_failure");
        return;
      }
      this.invalidateRouteTransition(entry, "session_resume_failed");
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        err,
        phase: "resume",
        classification,
        attemptedMessage: message ?? null,
      });
      if (this.sessions.get(entry.chatId) !== entry) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, message ?? null, handling);
    } finally {
      settleRouteProducer();
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
    err: unknown;
    phase: "start" | "resume";
    classification: ProviderFailureClassification;
    attemptedMessage: SessionMessage | null;
  }): Promise<SessionFailureHandling> {
    const { entry, err, phase, classification, attemptedMessage } = args;
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
      entry.retryHeadMessage = attemptedMessage;
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
      this.releaseActiveSlot(entry);
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
        this.emitSessionEvent(
          chatId,
          {
            kind: "error",
            payload: {
              source: "runtime",
              message: encodeProviderRetryEventMessage(payload),
            },
          },
          entry,
        );
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
    // Close retry admission before awaiting durable event confirmation. The
    // attempted message is already owned by the caller and deferred custody
    // remains on the entry for terminal teardown.
    this.clearRetryAttemptState(entry);
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
    const terminalMutationGeneration = entry.routeTransitionGeneration;
    const terminalMutationLeaseValid = () =>
      !this.shuttingDown &&
      this.sessions.get(chatId) === entry &&
      entry.routeTransitionGeneration === terminalMutationGeneration &&
      entry.status === "errored";
    const terminalEventPersisted = await this.emitConfirmedSessionEvent(
      chatId,
      {
        kind: "error",
        payload: {
          source: "runtime",
          message: encodeProviderRetryEventMessage(payload),
        },
      },
      entry,
      terminalMutationLeaseValid,
    );
    return { kind: "terminal", reasonCode: decision.reasonCode, terminalEventPersisted };
  }

  private async emitConfirmedSessionEvent(
    chatId: string,
    event: SessionEvent,
    expectedEntry: SessionEntry | null = null,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<boolean> {
    const captureLeaseValid = () =>
      (!expectedEntry || this.sessions.get(chatId) === expectedEntry) && (!mutationLeaseValid || mutationLeaseValid());
    if (this.config.confirmSessionEvent) {
      try {
        await this.config.confirmSessionEvent(chatId, event);
        if (!captureLeaseValid()) return false;
        return this.captureRuntimeFailureNotice(chatId, event, captureLeaseValid, expectedEntry);
      } catch (emitErr) {
        this.config.log.warn({ chatId, emitErr }, "confirmed session event emit failed");
        return false;
      }
    }
    try {
      this.config.onSessionEvent?.(chatId, event);
      this.captureRuntimeFailureNotice(chatId, event, captureLeaseValid, expectedEntry);
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
    this.invalidateRouteTransition(entry, "session_terminal_failure");
    const hasDeferredTail = entry.deferredMessages.length > 0;
    const hasRecoveryDebt = this.inboxDelivery.hasRecoveryDebt(chatId);
    this.clearRetryState(entry);
    if (handling.terminalEventPersisted && message && !hasRecoveryDebt) {
      await this.completeDeliveryTurn(chatId, message, {
        status: "error",
        terminal: true,
        completion: "consumed",
        reason: `session_failure_terminal:${handling.reasonCode}`,
      });
      if (this.sessions.get(chatId) !== entry) return;
      if (hasDeferredTail || this.inboxDelivery.hasRecoveryDebt(chatId)) {
        await this.inboxDelivery.drainForTerminate(chatId);
      }
    } else {
      await this.inboxDelivery.drainForTerminate(chatId);
    }

    if (this.sessions.get(chatId) !== entry) return;
    // Terminal cleanup previously left the handler's stop unconfirmed
    // (register-only debt that lingered until a terminate). Register-then-
    // shutdown instead: the debt mirrors the real shutdown timeline — a
    // confirmed stop drops it immediately, a failure keeps it retryable.
    this.detachHandlerWithPendingTeardown(chatId, entry.handler, "session_terminal_failure");
    this.sessions.delete(chatId);
    this.sessionRuntimeStates.delete(chatId);
    this.currentTrigger.delete(chatId);
    this.recomputeRuntimeState();
    this.releaseActiveSlot(entry);
    // Converge the registry like every other sessions.delete path: the
    // resumable mapping for this chat must not linger on disk. This
    // debounced write is hygiene only — a Reset terminate still carries its
    // own synchronous crash boundary (flushTerminateRegistry).
    this.persistRegistry();
    this.drainPendingQueue();
  }

  /**
   * Re-attempt a session that previously hit a transient failure. Called by
   * the retry timer and by user-triggered immediate retry (see
   * `triggerImmediateRetry`). Re-builds the handler — the old one may have
   * had its SDK transport torn down.
   */
  /**
   * Re-arm a chat's transient-retry timer with the standard short delay.
   * Shared by every executeRetry exit that keeps retry custody (debt-settle
   * failure, replacement-stop failure, slot contention) — single-flight
   * guarantees only one such path can run per chat at a time, so this is
   * the only re-arm handle.
   *
   * Fail closed: a re-arm only makes sense while this exact entry still
   * owns the chat's retry lifecycle. A manager shutdown clears retry timers
   * exactly once — a re-arm after that sweep would survive it and fire
   * after AgentSlot.stopOnce() returned. A terminate explicitly cancels the
   * retry timer — re-arming while one is in flight would resurrect a route
   * the operator just stopped (the failed apply is retried by the operator,
   * not by a stray timer).
   */
  private rearmRetryTimer(chatId: string, entry: SessionEntry, delayMs = 5_000): void {
    if (this.shuttingDown) return;
    if (this.isProviderRouteAdmissionFenced(chatId)) return;
    if (this.sessions.get(chatId) !== entry) return;
    if (
      entry.status !== "suspended" ||
      entry.activeSlotHeld ||
      entry.routeTransition !== null ||
      entry.retryAttempt === 0
    ) {
      return;
    }
    // Defensive: never overwrite a live handle with a duplicate timer.
    if (entry.retryTimer !== null) return;
    entry.retryNextAt = Date.now() + delayMs;
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = null;
      this.runRetry(chatId).catch((err) => {
        this.config.log.warn({ chatId, err }, "session retry rearm failed");
      });
    }, delayMs);
  }

  private runRetry(chatId: string): Promise<void> {
    // Single-flight per chat: the whole execution — including a failing
    // replacement shutdown and the re-arm timer it creates — must have
    // exactly one concurrent owner. Without this, two overlapping callers
    // (retry timer + immediate trigger) would both run the failure path
    // and each arm its own re-arm timer, the second handle overwriting the
    // first in `entry.retryTimer` and leaving an untracked timer that
    // manager shutdown cannot clear.
    const inFlight = this.retryFlights.get(chatId);
    if (inFlight) return inFlight;
    const flight = this.executeRetry(chatId);
    this.retryFlights.set(chatId, flight);
    void flight.then(
      () => {
        if (this.retryFlights.get(chatId) === flight) this.retryFlights.delete(chatId);
      },
      () => {
        if (this.retryFlights.get(chatId) === flight) this.retryFlights.delete(chatId);
      },
    );
    return flight;
  }

  private async executeRetry(chatId: string): Promise<void> {
    if (this.shuttingDown) return;
    if (this.isProviderRouteAdmissionFenced(chatId)) return;
    const entry = this.sessions.get(chatId);
    if (!entry) return;
    if (
      entry.status !== "suspended" ||
      entry.activeSlotHeld ||
      entry.routeTransition !== null ||
      entry.retryAttempt === 0
    ) {
      return;
    }
    if (this.inboxDelivery.hasRecoveryDebt(chatId)) {
      this.clearRetryState(entry);
      await this.inboxDelivery.recoverIfNeeded(chatId, "session_retry:recovery_debt");
      this.projectSessionRuntime(chatId);
      return;
    }

    const retryHeadMessage = entry.retryHeadMessage;
    const previousSessionId = entry.claudeSessionId || entry.retryFromEvicted?.claudeSessionId || "";
    const retryRoute = previousSessionId
      ? { kind: "resume" as const, message: retryHeadMessage, previousSessionId }
      : retryHeadMessage
        ? { kind: "start" as const, message: retryHeadMessage }
        : null;
    if (
      retryHeadMessage?.inboxEntryId !== undefined &&
      !this.inboxDelivery.hasEntry({
        chatId,
        messageId: retryHeadMessage.id,
        entryId: retryHeadMessage.inboxEntryId,
      })
    ) {
      this.config.log.warn(
        {
          chatId,
          messageId: retryHeadMessage.id,
          entryId: retryHeadMessage.inboxEntryId,
        },
        "session retry head lost inbox custody; requesting recovery",
      );
      this.failSessionForRecovery(chatId, "session_retry_head_custody_missing", previousSessionId);
      await this.inboxDelivery.recoverIfNeeded(chatId, "session_retry_head_custody_missing");
      return;
    }
    if (!retryRoute) {
      this.config.log.error({ chatId }, "session start retry has no input; requesting recovery");
      this.failSessionForRecovery(chatId, "session_retry_head_missing");
      await this.inboxDelivery.recoverIfNeeded(chatId, "session_retry_head_missing");
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

    // Route admission fence: settle this chat's teardown debt before the
    // retry builds a fresh handler. On failure keep retry custody — re-arm
    // with the same short-delay pass as slot contention below.
    if (!(await this.settleTeardownDebtBeforeRoute(chatId))) {
      this.rearmRetryTimer(chatId, entry);
      return;
    }

    // The settle awaited: re-validate before installing anything. A
    // terminate may have started while this retry waited on the debt — it
    // snapshots and drains the SAME debt and its producer quiesce has
    // already passed, so installing now would ack over a live fresh route.
    // Same for a manager shutdown. Abandon the install per the entry-guard
    // semantics at the top of this function: no new handler is installed,
    // and the retry choreography is left to whoever now owns the chat
    // (terminate clears the entry; shutdown clears the timers).
    if (this.shuttingDown) return;
    if (this.isProviderRouteAdmissionFenced(chatId)) return;
    if (
      this.sessions.get(chatId) !== entry ||
      entry.status !== "suspended" ||
      entry.activeSlotHeld ||
      entry.routeTransition !== null ||
      entry.retryAttempt === 0
    ) {
      return;
    }

    // Fresh handler — the old one may have closed its SDK transport. But the
    // replaced handler must be CONFIRMED stopped before the fresh one is
    // installed, or the chat runs two live handlers. The debt is registered
    // BEFORE the stop starts: while the stop is in flight the entry is
    // slot-free, so an untracked stop would let a terminate ack (or a
    // manager shutdown return) over a handler whose stop has not settled.
    // The raw face clears the debt on a confirmed stop; a failure keeps it
    // (joinable for terminate/reconcile) and the retry keeps its custody
    // via the same re-arm as slot contention, instead of silently
    // continuing.
    this.registerPendingTeardown(chatId, entry.handler);
    try {
      await this.shutdownHandler(entry.handler, "session_retry_replace", { observeFailure: true });
      this.dropPendingTeardown(chatId, entry.handler);
    } catch (err) {
      this.config.log.warn({ chatId, err }, "session retry replace-stop failed; keeping retry custody");
      this.rearmRetryTimer(chatId, entry);
      return;
    }
    // The stop awaited: re-run the FULL retry-eligibility CAS — a terminate
    // or manager shutdown may have started meanwhile, the entry may have
    // been replaced, and an overlapping runRetry (timer + immediate) may
    // already have installed the replacement route. Abandon the install
    // instead of opening a second provider route for the same retry head;
    // the winner's route owns the head's custody.
    if (
      this.shuttingDown ||
      this.isProviderRouteAdmissionFenced(chatId) ||
      this.sessions.get(chatId) !== entry ||
      entry.status !== "suspended" ||
      entry.activeSlotHeld ||
      entry.routeTransition !== null ||
      entry.retryAttempt === 0
    ) {
      return;
    }

    // Capacity decision LAST, immediately before the synchronous install.
    // Acquiring earlier would be a check-then-act race across chats: two
    // retries could both pass the check while each awaits its own
    // replacement stop (or while another route consumes the freed slot),
    // then both claim — exceeding the configured concurrency. With the
    // acquire directly adjacent to the claim (no await in between), the
    // invariant `activeCount <= concurrency` holds under any interleaving.
    // On failure the entry stays in transient-retry state and a future
    // retry / message will try again.
    if (!this.acquireActiveSlot(chatId, retryRoute.message, "recovery", { queueOnFailure: false })) {
      this.rearmRetryTimer(chatId, entry);
      return;
    }

    const newHandler = this.createHandler();
    entry.handler = newHandler;
    entry.status = "active";
    this.claimActiveSlot(entry);
    entry.lastActivity = Date.now();
    const transition = this.beginRouteTransition(entry, newHandler, retryRoute.kind);
    const mutationValid = () => this.isRouteAdoptionValid(entry, transition);
    const settlementValid = () => this.isDeliverySettlementLeaseValid(entry, transition);
    const routeLeases = { mutationValid, settlementValid };
    const ctx = this.buildSessionContext(chatId, routeLeases);

    this.notifySessionState(chatId, "active");
    this.projectSessionRuntime(chatId, { drainPendingOnIdle: false });
    // Settle callback for the route producer, assigned as the FIRST
    // statement inside the try below: a throw before registration leaves no
    // producer behind, and everything after registration is covered by the
    // finally — so no throw can leave a producer that never settles.
    let settleRouteProducer: () => void = () => {};
    try {
      // Track the route producer: a canceled retry route can still
      // materialize late, and terminate / manager shutdown join this before
      // ack/return.
      settleRouteProducer = this.registerRouteProducer(chatId);
      if (retryHeadMessage) this.setCurrentTrigger(chatId, retryHeadMessage);
      const token = retryHeadMessage ? this.createDeliveryToken(chatId, routeLeases) : undefined;
      if (retryRoute.kind === "resume") {
        const resumeResult = token
          ? await newHandler.resume(retryHeadMessage ?? undefined, retryRoute.previousSessionId, ctx, token)
          : await newHandler.resume(undefined, retryRoute.previousSessionId, ctx);
        if (!this.isCurrentRouteTransition(entry, transition)) {
          this.discardStaleRouteTransition(entry.chatId, transition, "session_retry_resume_stale_completion");
          return;
        }
        const receipt = normalizeResumeReceipt(resumeResult);
        if (!this.adoptResumeReceipt(entry, retryHeadMessage, receipt, "session_retry_resume_unowned_delivery")) {
          return;
        }
      } else {
        const receipt = normalizeStartReceipt(
          await newHandler.start(retryRoute.message, ctx, this.createDeliveryToken(chatId, routeLeases)),
        );
        if (!this.isCurrentRouteTransition(entry, transition)) {
          this.discardStaleRouteTransition(entry.chatId, transition, "session_retry_start_stale_completion");
          return;
        }
        entry.claudeSessionId = receipt.sessionId;
        if (this.markRouteOwned(chatId, retryRoute.message, receipt.route) === "lost") {
          this.abortUnownedRoute(entry, "session_retry_start_unowned_delivery");
          return;
        }
      }
      const totalAttempts = entry.retryAttempt;
      const succeededScope = entry.lastRetryScope ?? (previousAvailable(entry) ? "session_resume" : "session_start");
      const succeededClassification = this.retryClassificationForEntry(entry);
      if (!this.completeRouteTransition(entry, transition)) {
        this.discardStaleRouteTransition(entry.chatId, transition, "session_retry_stale_adoption");
        return;
      }
      this.clearRetryAttemptState(entry);
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
      this.drainDeferredMessages(entry);
      this.persistRegistry();
    } catch (err) {
      if (!this.isCurrentRouteTransition(entry, transition)) {
        this.discardStaleRouteTransition(entry.chatId, transition, "session_retry_stale_failure");
        return;
      }
      this.invalidateRouteTransition(entry, "session_retry_failed");
      const phase = retryRoute.kind;
      const classification = classifyProviderFailure(err, {
        provider: this.runtimeProvider(),
        scope: phase === "start" ? "session_start" : "session_resume",
        source: "session",
      });
      const handling = await this.handleSessionFailure({
        entry,
        err,
        phase,
        classification,
        attemptedMessage: retryHeadMessage,
      });
      if (this.sessions.get(chatId) !== entry) return;
      if (handling.kind === "terminal") await this.teardownTerminalSessionFailure(entry, retryHeadMessage, handling);
    } finally {
      settleRouteProducer();
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
    // Managed-Skill discovery safety is a local provider-preflight gate, not
    // an availability hint that newer input can bypass. Keep the original
    // head and FIFO tail behind the bounded timer so repeated deliveries or
    // resume commands cannot turn the safety wait into a hot retry loop.
    if (entry.lastRetryReason === MANAGED_SKILLS_UNSAFE_DISCOVERY_REASON_CODE) return;
    if (entry.retryTimer) {
      clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    void this.runRetry(chatId);
  }

  /**
   * Open live inject for an in-flight start/resume once the head delivery
   * token reports processingStarted. Drain any FIFO tail that arrived before
   * this proof while the route producer may still be awaiting settlement.
   */
  private markRouteInjectReady(chatId: string): void {
    const entry = this.sessions.get(chatId);
    if (!entry || entry.routeTransition === null) return;
    // Waiting/backoff retries have no transition and never reach here. An
    // in-flight retry transition that has proven membership may open live
    // inject even while retryAttempt remains nonzero until start/resume returns.
    if (entry.status !== "active" || !entry.activeSlotHeld) return;
    entry.routeInjectReady = true;
    this.drainDeferredMessages(entry);
  }

  private injectIntoActiveRoute(entry: SessionEntry, message: SessionMessage): void {
    const chatId = entry.chatId;
    const routeLease = {
      generation: entry.routeTransitionGeneration,
      handler: entry.handler,
    };
    const mutationValid = () => this.isRouteAdoptionValid(entry, routeLease);
    const settlementValid = () => this.isDeliverySettlementLeaseValid(entry, routeLease);
    if (!mutationValid()) {
      this.retryDeliveryTurn(chatId, message, "active_inject_route_invalidated");
      return;
    }
    this.setCurrentTrigger(chatId, message);
    const attempt = this.createDeliveryAttempt(chatId, { mutationValid, settlementValid });
    let receipt: HandlerRouteReceipt;
    try {
      receipt = normalizeRouteReceipt(routeLease.handler.inject(message, attempt.token));
    } catch (err) {
      attempt.cancel();
      throw err;
    }
    if (!mutationValid()) {
      attempt.cancel();
      this.retryDeliveryTurn(chatId, message, "active_inject_route_invalidated");
      return;
    }
    if (receipt.kind === "rejected") attempt.cancel();
    const ownership = this.markRouteOwned(chatId, message, receipt);
    if (ownership !== "owned") attempt.cancel();
    if (ownership === "lost") {
      return;
    }
    entry.lastActivity = Date.now();
    this.projectSessionRuntime(chatId);
    this.config.log.debug({ chatId }, "message injected");
  }

  private drainDeferredMessages(entry: SessionEntry): void {
    if (entry.deferredMessages.length === 0) return;

    const queued = entry.deferredMessages.splice(0);
    const routeLease = {
      generation: entry.routeTransitionGeneration,
      handler: entry.handler,
    };
    const mutationValid = () => this.isRouteAdoptionValid(entry, routeLease);
    const settlementValid = () => this.isDeliverySettlementLeaseValid(entry, routeLease);
    for (let index = 0; index < queued.length; index++) {
      const message = queued[index];
      if (!message) continue;
      if (!mutationValid() || this.inboxDelivery.hasRecoveryDebt(entry.chatId)) {
        this.retryDeliveryTurn(entry.chatId, queued.slice(index), "deferred_inject_recovery_pending");
        break;
      }
      this.setCurrentTrigger(entry.chatId, message);
      const attempt = this.createDeliveryAttempt(entry.chatId, { mutationValid, settlementValid });
      try {
        const receipt = normalizeRouteReceipt(routeLease.handler.inject(message, attempt.token));
        if (!mutationValid()) {
          attempt.cancel();
          this.retryDeliveryTurn(entry.chatId, queued.slice(index), "deferred_inject_route_invalidated");
          break;
        }
        if (receipt.kind === "rejected") attempt.cancel();
        const ownership = this.markRouteOwned(entry.chatId, message, receipt);
        if (ownership !== "owned") attempt.cancel();
        if (ownership === "lost") {
          this.retryDeliveryTurn(entry.chatId, queued.slice(index), "deferred_inject_custody_lost");
          break;
        }
        entry.lastActivity = Date.now();
      } catch (err) {
        attempt.cancel();
        this.config.log.warn({ chatId: entry.chatId, messageId: message.id, err }, "retry queued inject failed");
        this.retryDeliveryTurn(entry.chatId, queued.slice(index), "retry_queued_inject_failed");
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
   * Returns true if a slot is acquired and false if it remains unavailable.
   * Callers normally enqueue on failure; retry-scoped callers can opt out so
   * their timer/head state remains the single waiting source. The in-flight entryId
   * is tracked separately in `InboxDeliveryCoordinator` (populated at dispatch),
   * so the queue doesn't carry inbox metadata.
   */
  private acquireActiveSlot(
    chatId: string,
    message: SessionMessage | null,
    deliveryKind: SlotDeliveryKind = "fresh",
    opts: { queueOnFailure?: boolean } = {},
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

    if (opts.queueOnFailure !== false) {
      this.queueForSlot(chatId, message, deliveryKind, "concurrency_limit");
    }
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
    // A new suspend supersedes any earlier suspend outcome.
    entry.suspendError = null;
    entry.handlerStoppedBySuspend = null;

    if (opts.operatorResolution) {
      // Manual operator suspend is a resolution boundary for the contiguous
      // provider-entered prefix. Fence in-flight start/resume *adoption*
      // immediately by clearing the route pointer, but keep
      // routeTransitionGeneration stable through settle so already-issued
      // DeliveryTokens can still post notice+ACK. Bump + retire only after.
      // Do not re-bump delivery admission here — handleCommand already did.
      const inFlightTransition = entry.routeTransition;
      const unestablishedStart = inFlightTransition?.phase === "start";
      if (unestablishedStart) {
        entry.deferredMessages = [];
        this.clearRetryState(entry);
      } else if (inFlightTransition) {
        entry.deferredMessages = [];
      }
      // Clear the transition pointer and its inject-readiness latch together.
      // Status fencing already blocks immediate inject, and beginRouteTransition
      // resets readiness later, but leaving routeInjectReady true with a null
      // transition is contradictory state a future branch must not reuse.
      entry.routeTransition = null;
      entry.routeInjectReady = false;
      entry.status = "suspended";
      this.releaseActiveSlot(entry);
      this.sessionRuntimeStates.delete(entry.chatId);
      this.recomputeRuntimeState();
      entry.suspending = (async () => {
        let settled = false;
        try {
          // settleProviderEntered keeps already-issued DeliveryTokens on the
          // settlement lease (including active/deferred inject) so they can
          // post durable notice+ACK before prepareOperatorSuspend runs.
          await entry.handler.suspend(opts.reason, { settleProviderEntered: true });
          // If settle captured a terminal notice but could not persist it (or
          // could not claim token settlement), transfer the obligation onto
          // the inbox ledger so prepareOperatorSuspend / recovery cannot ACK
          // without durable notice evidence.
          if (entry.pendingRuntimeFailureNotice) {
            this.inboxDelivery.markNoticeRequiredForProcessingPrefix(entry.chatId, entry.pendingRuntimeFailureNotice);
          }
          settled = true;
        } catch (err) {
          // Settle failure leaves the handler joinable for a strict terminate /
          // resume stop — do not start teardown here or suspend will hang on a
          // gated shutdown the terminate owns.
          entry.suspendError = { error: err };
          try {
            this.config.log.warn({ chatId: entry.chatId, err }, "operator suspend settlement error");
          } catch (logErr) {
            this.config.log.warn({ chatId: entry.chatId, err: logErr }, "operator suspend settlement error");
          }
        }

        // Bump adoption generation only after settle. Kick observeFailure
        // teardown before awaiting prepare so a gated prepare still leaves an
        // in-flight shutdown that strict terminate can join (main #2125).
        entry.routeTransitionGeneration++;
        const target = inFlightTransition?.handler ?? entry.handler;
        if (inFlightTransition) {
          this.retiredHandlers.add(inFlightTransition.handler);
        }

        if (!settled) {
          entry.suspending = null;
          if (unestablishedStart) {
            if (entry.handlerStoppedBySuspend !== entry.handler) {
              this.registerPendingTeardown(entry.chatId, entry.handler);
            }
            if (this.sessions.get(entry.chatId) === entry) {
              this.sessions.delete(entry.chatId);
              this.currentTrigger.delete(entry.chatId);
            }
          }
          return;
        }

        const stopPromise =
          inFlightTransition || !this.retiredHandlers.has(entry.handler)
            ? this.shutdownHandler(target, opts.reason, { observeFailure: true })
            : Promise.resolve();

        try {
          // Yield once so an already-scheduled teardown can enter (and, for
          // instantaneous mocks, finish) before prepare publishes recovery
          // debt. Late route materialization then afterPrior-chains a second
          // stop instead of racing the first (main invalidate-at-entry timing).
          await Promise.resolve();
          await this.inboxDelivery.prepareOperatorSuspend(entry.chatId);
          await stopPromise;
          if (target === entry.handler) {
            entry.handlerStoppedBySuspend = entry.handler;
          }
        } catch (err) {
          entry.suspendError = { error: err };
          try {
            this.config.log.warn({ chatId: entry.chatId, err }, "operator suspend teardown error");
          } catch (logErr) {
            this.config.log.warn({ chatId: entry.chatId, err: logErr }, "operator suspend teardown error");
          }
        }

        entry.suspending = null;
        if (unestablishedStart) {
          if (entry.handlerStoppedBySuspend !== entry.handler) {
            this.registerPendingTeardown(entry.chatId, entry.handler);
          }
          if (this.sessions.get(entry.chatId) === entry) {
            this.sessions.delete(entry.chatId);
            this.currentTrigger.delete(entry.chatId);
          }
        }
      })();
      this.persistRegistry();
      this.notifySessionState(entry.chatId, "suspended");
      if (opts.drainQueue !== false) this.drainPendingQueue();
      return;
    }

    const canceledTransition = this.invalidateRouteTransition(entry, opts.reason);
    // A canceled fresh start has never established a provider-neutral resume
    // handle. Keeping that entry as "suspended" would make redelivery call
    // resume(undefined/empty-id) instead of starting a replacement route.
    // Drop only the local SessionEntry; coordinator recovery retains the head.
    const canceledUnestablishedStart = canceledTransition?.phase === "start";
    if (canceledTransition) entry.deferredMessages = [];
    if (canceledUnestablishedStart) this.clearRetryState(entry);
    const prepare = opts.ackConsumedPrefix
      ? this.inboxDelivery.prepareSuspend(entry.chatId, opts.reason)
      : Promise.resolve(this.inboxDelivery.prepareEvict(entry.chatId, opts.reason));
    entry.status = "suspended";
    this.releaseActiveSlot(entry);
    // Clear per-session runtime state on suspend
    this.sessionRuntimeStates.delete(entry.chatId);
    this.recomputeRuntimeState();
    entry.suspending = prepare
      .then(async () => {
        if (canceledTransition || this.retiredHandlers.has(entry.handler)) {
          // The suspend boundary must cover this teardown end-to-end:
          // returning (not void-ing) the shutdown keeps `entry.suspending`
          // in flight until the handler is confirmed stopped, and the
          // observeFailure face routes a shutdown rejection into the catch
          // below (recorded as suspendError) where a Reset terminate can see
          // it. Only a CONFIRMED stop arms the no-double-teardown marker,
          // bound to the handler identity so a later handler replacement
          // cannot inherit it.
          const target = canceledTransition?.handler ?? entry.handler;
          await this.shutdownHandler(target, opts.reason, { observeFailure: true });
          if (target === entry.handler) entry.handlerStoppedBySuspend = entry.handler;
          return;
        }
        return entry.handler.suspend(opts.reason);
      })
      .catch((err) => {
        // `suspending` keeps its legacy resolve-always contract for
        // dispatch/resume awaiters, but a terminate joining this suspend
        // must still observe the failure — record it (boxed: rejections can
        // be falsey) on the entry so the Reset apply can reject instead of
        // acking over a handler that was never confirmed suspended/stopped.
        entry.suspendError = { error: err };
        try {
          this.config.log.warn({ chatId: entry.chatId, err }, "suspend preparation error");
        } catch (logErr) {
          // Second-stage warn must not reject the suspending promise if the
          // logger transport itself throws.
          this.config.log.warn({ chatId: entry.chatId, err: logErr }, "suspend error");
        }
      })
      .then(() => undefined)
      .catch((err) => {
        try {
          this.config.log.warn({ chatId: entry.chatId, err }, "suspend error");
        } catch (logErr) {
          this.config.log.warn({ chatId: entry.chatId, err: logErr }, "suspend error");
        }
      })
      .finally(() => {
        entry.suspending = null;
        // Keep the unestablished entry addressable until preparation settles:
        // dispatch() uses its suspending promise as the same-chat admission
        // fence while operator ACK/recovery decisions are still in flight.
        if (canceledUnestablishedStart) {
          // Debt registration must NOT depend on the entry still being
          // installed: even if another path already removed it (its own
          // detach registers too — Set semantics make a duplicate a no-op),
          // an unconfirmed-stop handler must stay joinable.
          if (entry.handlerStoppedBySuspend !== entry.handler) {
            this.registerPendingTeardown(entry.chatId, entry.handler);
          }
          if (this.sessions.get(entry.chatId) === entry) {
            this.sessions.delete(entry.chatId);
            this.currentTrigger.delete(entry.chatId);
          }
        }
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
      // A chat with unresolved teardown debt is not a burden-free victim:
      // its detached handlers are still being confirmed stopped, so keep it
      // out of the candidate set (force-keep).
      if (this.pendingTeardowns.has(key)) continue;
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
      this.invalidateRouteTransition(candidate.session, "session_evicted");
      // Preserve only an adopted, provider-neutral resume handle. Transition
      // phase is not sufficient: a fresh-start retry/terminal window has no
      // active start transition but still has no resumable provider session.
      const resumableSessionId = resumableProviderSessionId(
        candidate.session.claudeSessionId,
        candidate.session.retryFromEvicted?.claudeSessionId,
      );
      if (resumableSessionId) {
        this.addEvictedMapping(candidate.key, {
          claudeSessionId: resumableSessionId,
          lastActivity: candidate.session.lastActivity,
        });
      } else {
        this.evictedMappings.delete(candidate.key);
      }

      this.config.log.info({ chatId: candidate.key }, "session evicted (max_sessions reached)");
      const activeSlotHeld = candidate.session.activeSlotHeld;
      this.releaseActiveSlot(candidate.session);
      if (activeSlotHeld) {
        this.detachHandlerWithPendingTeardown(candidate.key, candidate.session.handler, "session_evicted");
      } else {
        // A non-active handler is not shut down on eviction (existing
        // semantics), but its stop is unconfirmed — record the debt.
        this.registerPendingTeardown(candidate.key, candidate.session.handler);
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
    const resumableSessionId = resumableProviderSessionId(mapping.claudeSessionId);
    if (!resumableSessionId) {
      this.evictedMappings.delete(chatId);
      return;
    }
    this.evictedMappings.set(chatId, { ...mapping, claudeSessionId: resumableSessionId });
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

  private buildSessionContext(
    chatId: string,
    lease:
      | (() => boolean)
      | {
          /** Fenced by shuttingDown — route/session/registry mutations. */
          mutationValid: () => boolean;
          /** Ignores shuttingDown — terminal notice capture + finish/retry only. */
          settlementValid: () => boolean;
        }
      | null = null,
  ): SessionContext {
    const mutationValid = typeof lease === "function" ? lease : (lease?.mutationValid ?? null);
    const settlementValid =
      typeof lease === "function" ? lease : (lease?.settlementValid ?? lease?.mutationValid ?? null);
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
      clearTrigger: () => {
        this.currentTrigger.delete(chatId);
      },
      log,
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
      freshStartNonce: () => this.registry?.getFreshStartNonce(chatId),
      recordProviderActivity: () => {
        if (mutationValid && !mutationValid()) return;
        const entry = this.sessions.get(chatId);
        if (entry && entry.status === "active") {
          entry.lastActivity = Date.now();
        }
      },
      emitEvent: (event) => {
        // During graceful drain, only structured terminal provider-failure events
        // may cross the settlement lease (durable notice capture). All other
        // session-context events stay behind the shuttingDown adoption fence.
        if (isTerminalProviderFailureSessionEvent(event)) {
          if (settlementValid && !settlementValid()) return;
          this.config.onSessionEvent?.(chatId, event);
          if (settlementValid && !settlementValid()) return;
          this.captureRuntimeFailureNotice(chatId, event, settlementValid);
          return;
        }
        if (mutationValid && !mutationValid()) return;
        this.config.onSessionEvent?.(chatId, event);
        if (mutationValid && !mutationValid()) return;
        this.captureRuntimeFailureNotice(chatId, event, mutationValid);
      },
      emitEventConfirmed: (event) => {
        if (mutationValid && !mutationValid()) {
          return Promise.reject(new Error("route transition invalidated"));
        }
        return this.confirmSessionEventOrThrow(chatId, event, mutationValid);
      },
      forwardResult: (text) => {
        if (mutationValid && !mutationValid()) return Promise.resolve();
        return forwardResult(text);
      },
      markMessagesConsumed: (messages) => {
        if (mutationValid && !mutationValid()) return;
        this.inboxDelivery.markProcessingStarted(chatId, messages);
      },
      finishTurn: (messages, outcome) => {
        // SessionContext finish/retry stay behind the adoption fence. Already-issued
        // DeliveryTokens carry the settlement lease for drain notice+ACK.
        if (mutationValid && !mutationValid()) return Promise.resolve();
        return this.completeDeliveryTurn(chatId, messages, outcome, mutationValid);
      },
      retryTurn: (messages, reason) => {
        if (mutationValid && !mutationValid()) return;
        this.retryDeliveryTurn(chatId, messages, reason);
        this.projectSessionRuntime(chatId);
      },
      hasPendingDelivery: (messages) => {
        const batch = Array.isArray(messages) ? messages : [messages];
        return batch.some(
          (message) =>
            message.inboxEntryId !== undefined &&
            this.inboxDelivery.hasEntry({
              chatId,
              entryId: message.inboxEntryId,
              messageId: message.id,
            }),
        );
      },
      failSessionForRecovery: (reason, sessionId) => {
        if (mutationValid && !mutationValid()) return;
        this.failSessionForRecovery(chatId, reason, sessionId);
      },
      replaceSessionId: (sessionId, reason) => {
        if (mutationValid && !mutationValid()) return;
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

  private async confirmSessionEventOrThrow(
    chatId: string,
    event: SessionEvent,
    mutationLeaseValid: (() => boolean) | null = null,
  ): Promise<void> {
    if (mutationLeaseValid && !mutationLeaseValid()) {
      throw new Error("route transition invalidated");
    }
    if (!this.config.confirmSessionEvent) {
      this.config.onSessionEvent?.(chatId, event);
      throw new Error("confirmed session event channel unavailable");
    }
    await this.config.confirmSessionEvent(chatId, event);
    if (mutationLeaseValid && !mutationLeaseValid()) {
      throw new Error("route transition invalidated");
    }
    this.captureRuntimeFailureNotice(chatId, event, mutationLeaseValid);
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

    const { entries } = this.registry.loadSnapshot();
    let loadedCount = 0;
    for (const [chatId, data] of entries) {
      // All persisted sessions become evicted mappings on load.
      // Handlers are allocated lazily when a message arrives (startNewSession
      // checks evictedMappings and calls handler.resume instead of start).
      const resumableSessionId = resumableProviderSessionId(data.claudeSessionId);
      if (!resumableSessionId) {
        this.config.log.warn({ chatId }, "ignoring persisted session mapping without a resumable provider session id");
        continue;
      }
      this.addEvictedMapping(chatId, {
        claudeSessionId: resumableSessionId,
        lastActivity: data.lastActivity,
      });
      loadedCount++;
    }

    if (loadedCount > 0) {
      this.config.log.info({ count: loadedCount }, "loaded persisted session mappings");
    }
  }

  private persistRegistry(opts: { immediate?: boolean; throwOnFailure?: boolean } = {}): void {
    if (!this.registry) return;

    const entries = new Map<string, { claudeSessionId: string; lastActivity: number; status: string }>();
    for (const [chatId, session] of this.sessions) {
      const resumableSessionId = resumableProviderSessionId(
        session.claudeSessionId,
        session.retryFromEvicted?.claudeSessionId,
      );
      if (!resumableSessionId) continue;
      entries.set(chatId, {
        claudeSessionId: resumableSessionId,
        lastActivity: session.lastActivity,
        status: session.status,
      });
    }
    // Include evicted mappings for crash recovery
    for (const [chatId, mapping] of this.evictedMappings) {
      const resumableSessionId = resumableProviderSessionId(mapping.claudeSessionId);
      if (!resumableSessionId) continue;
      entries.set(chatId, {
        claudeSessionId: resumableSessionId,
        lastActivity: mapping.lastActivity,
        status: "evicted",
      });
    }
    // On shutdown we MUST write synchronously: the alternative is
    // `save()` (debounced 1s) followed by `dispose()`, which races the
    // process exit and silently drops the last mapping batch.
    // `throwOnFailure` (Reset terminate) additionally surfaces write failure
    // to the caller instead of swallowing it.
    if (opts.throwOnFailure) this.registry.flushOrThrow(entries);
    else if (opts.immediate) this.registry.flush(entries);
    else this.registry.save(entries);
  }
}
