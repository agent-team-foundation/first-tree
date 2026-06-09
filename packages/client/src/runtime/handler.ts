import type { AgentVisibility, SessionEvent } from "@first-tree/shared";
import type { FirstTreeHubSDK } from "../sdk.js";
import type { GitMirrorManager } from "./git-mirror-manager.js";

/** Agent identity fields flowing from Server through the runtime pipeline. */
export type AgentIdentity = {
  agentId: string;
  /**
   * Agent's inbox ID. Carried alongside the agent identity so the runtime
   * can identify the agent's row in `inbox_entries` (poll / push paths) and
   * so child processes can read `FIRST_TREE_INBOX_ID` when they need a
   * stable identity handle. There is no `replyToInbox` envelope any more —
   * cross-chat reply routing was removed in first-tree-context PR #281.
   */
  inboxId: string;
  /**
   * Always populated post-Phase 2 of the agent-naming refactor — the server
   * enforces `agents.display_name NOT NULL` (migration 0024) and the
   * `agent:pinned` WebSocket frame it emits resolves the fallback before
   * sending, so the client no longer has to second-guess the value.
   */
  displayName: string;
  type: string;
  /**
   * Post-type-merge (migration 0051) `type` only distinguishes
   * `human` vs `agent`; the "personal vs. shared" axis lives here in
   * `visibility`. Renderers that need to know whether a non-human row is a
   * personal assistant (private) or an autonomous bot (organization) MUST
   * gate on this field rather than inferring from `delegateMention` — the
   * latter is null on every non-human row (only `human` can carry a
   * delegate; see `services/agent.ts:assertDelegateMentionAllowed`).
   */
  visibility: AgentVisibility;
  delegateMention: string | null;
  metadata: Record<string, unknown>;
};

export type HandlerContext = {
  /** Agent identity from Server. */
  agent: AgentIdentity;
  /** SDK for sending messages and managing inbox. */
  sdk: FirstTreeHubSDK;
  /** Logger scoped to this agent slot. */
  log: (msg: string) => void;
};

/** Extended context for session-oriented handlers. */
export type SessionContext = HandlerContext & {
  /** The server-side chat this session belongs to. */
  chatId: string;
  /** Refresh `lastActivity` timestamp to prevent idle timeout. */
  touch: () => void;
  /** Report per-session runtime state (working/idle/blocked/error). */
  setRuntimeState: (state: "idle" | "working" | "blocked" | "error") => void;
  /**
   * Persist a structured session event (tool_call / error) to the server.
   * Assistant text does NOT go through here — it flows via `forwardResult`.
   */
  emitEvent: (event: SessionEvent) => void;

  /**
   * Forward the handler's final text to the chat. Runtime handles mention
   * extraction, `inReplyTo`, participants lookup, and transport — handlers
   * just pass the raw output text.
   */
  forwardResult: (text: string) => Promise<void>;

  /**
   * Mark a single-message turn complete. Built-in handlers should prefer
   * `markMessagesCompleted(messageOrBatch)` so the runtime can ack-through
   * the exact inbox entry the handler actually consumed.
   */
  markCompleted: () => void;

  /**
   * Mark the concrete message or fused batch as entered into the current
   * provider turn. This is an in-memory boundary used by suspend: consumed
   * entries can be ACKed when the turn is paused, while handler queues that
   * have not entered the provider stay unacked for recovery.
   */
  markMessagesConsumed: (messages: SessionMessage | readonly SessionMessage[]) => void;

  /**
   * Mark the concrete message or fused message batch a handler has actually
   * consumed. The runtime sends one `inbox:ack` for the last message's
   * `inboxEntryId`; the server interprets it as ack-through for the chat's
   * delivered prefix. This replaces the old `markCompleted(count)` FIFO
   * pairing, which could ack an older queued entry while the completed entry
   * remained unacked.
   */
  markMessagesCompleted: (messages: SessionMessage | readonly SessionMessage[]) => void;

  /**
   * Mark a concrete message or batch as abandoned by a retryable path
   * (abort, timeout, unknown failure). The runtime leaves the server-side
   * entries unacked; a later chat recovery or bind reset redelivers them.
   */
  markMessagesRetryable: (messages: SessionMessage | readonly SessionMessage[], reason: string) => void;

  /**
   * Build env for CLI sub-processes that shell out to the First Tree CLI.
   * Layers First Tree envelope vars (server/agent/inbox/chat IDs) on
   * top of the parent env. Handlers pass their own cleaned `process.env`.
   */
  buildAgentEnv: (parentEnv: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

  /**
   * Format an inbound message's content for handoff to an LLM — prefixes a
   * `[From: <name>]` attribution line when the sender is a participant of
   * this chat. Handler implementations should wrap whatever LLM-specific
   * message envelope they build around the string this returns.
   *
   * Async because resolving the name may require a one-time participant
   * fetch; the runtime caches the result for the lifetime of the session.
   */
  formatInboundContent: (message: SessionMessage) => Promise<string>;

  /**
   * Resolve a senderId to its chat-local name (the `@<name>` mention token).
   * Falls back to displayName, then to the raw senderId. Share the same
   * participant cache as `formatInboundContent`. Handlers that synthesise
   * content (e.g. the image path's "An image was shared" prompt) call this
   * to keep `[From: ...]` attribution consistent with the text path.
   */
  resolveSenderLabel: (senderId: string) => Promise<string>;
};

/** Message content extracted from an inbox entry (no entry metadata). */
export type SessionMessage = {
  /** Inbox entry id that delivered this message to the current agent. */
  inboxEntryId?: number;
  /** Message ID (UUID v7). */
  id: string;
  /** Chat this message belongs to. */
  chatId: string;
  /** Sender agent ID. */
  senderId: string;
  /** Message format. */
  format: string;
  /** Message content (text or structured). */
  content: string | Record<string, unknown>;
  /** Optional metadata. */
  metadata: Record<string, unknown> | null;
  /**
   * Group-chat history the recipient missed (mention_only + not @mentioned)
   * up to this triggering message. Sorted oldest-first. Server attaches and
   * also acks these — the runtime only renders them as preceding context in
   * the prompt; it must NOT try to ack them individually.
   * See proposals/group-chat-ux-improvements §1 (silent inbox).
   */
  precedingMessages?: PrecedingMessage[];
};

export type PrecedingMessage = {
  id: string;
  senderId: string;
  format: string;
  content: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
};

/**
 * Session-oriented agent handler.
 *
 * Each handler instance owns the full lifecycle of a Claude session
 * for a single chat. The Runtime manages one handler per chatId.
 */
export type AgentHandler = {
  /** First message in a new chat. Spawn query, start consumer loop. Returns claudeSessionId. */
  start(message: SessionMessage, ctx: SessionContext): Promise<string>;

  /** Message arrives for a suspended/evicted chat. Resume query from disk. Returns claudeSessionId.
   *  `message` is undefined for admin-triggered resume (no new user input). */
  resume(message: SessionMessage | undefined, sessionId: string, ctx: SessionContext): Promise<string>;

  /** Message arrives while session is active. Push into InputController. Synchronous. */
  inject(message: SessionMessage): void;

  /** Idle timeout. Close query, preserve state for resume. */
  suspend(): Promise<void>;

  /** Eviction or runtime shutdown. Same as suspend(). */
  shutdown(): Promise<void>;
};

/**
 * Factory function that each handler module exports.
 * Called once per session to create a handler instance.
 */
export type HandlerFactory = (config: HandlerConfig) => AgentHandler;

/** Configuration passed to handler factory. */
export type HandlerConfig = {
  /** Root directory for per-chat workspaces (`<dataDir>/workspaces/<agentName>`). */
  workspaceRoot: string;
  /**
   * Optional bare-mirror manager. When present, the handler materialises the
   * runtime config's `gitRepos` into `<cwd>/<localPath>` worktrees on session
   * start and removes them on shutdown (PRD §5.1.5 / §7.5). Absent in unit
   * tests that don't need git materialisation.
   */
  gitMirrorManager?: GitMirrorManager;
  /** Additional handler-specific config. */
  [key: string]: unknown;
};

/** Built-in handler registry. Populated by handler modules. */
const HANDLER_REGISTRY = new Map<string, HandlerFactory>();

/** Register a built-in handler type. */
export function registerHandler(type: string, factory: HandlerFactory): void {
  HANDLER_REGISTRY.set(type, factory);
}

/**
 * Non-throwing check for whether a handler factory is registered for `type`.
 *
 * Callers that materialise agents from config (daemon startup, `agent:pinned`
 * pushes, fs-watch rescans) use this to skip an agent whose runtime provider is
 * a valid enum value but has no handler on this client build yet — e.g. a
 * `claude-code-tui` agent on a client that predates the TUI handler. Without it
 * `getHandlerFactory` throws and takes down the whole startup loop.
 */
export function hasHandler(type: string): boolean {
  return HANDLER_REGISTRY.has(type);
}

/** Resolve a handler factory by type name. */
export function getHandlerFactory(type: string): HandlerFactory {
  const factory = HANDLER_REGISTRY.get(type);
  if (!factory) {
    const available = [...HANDLER_REGISTRY.keys()].join(", ") || "(none)";
    throw new Error(`Unknown handler type "${type}". Available: ${available}`);
  }
  return factory;
}
