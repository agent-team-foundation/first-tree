import type { AgentVisibility, RuntimeProvider, SessionEvent } from "@first-tree/shared";
import type { FirstTreeHubSDK } from "../sdk.js";

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

export type TurnConsumedErrorReason =
  | "forward_failed"
  | "provider_clean_error"
  | "usage_limit_notice_posted"
  | "stream_api_error_posted"
  | "retry_exhausted_notice_posted"
  | "auto_resume_failed_notice_posted"
  | (string & {});

export type TurnOutcome =
  | {
      status: "success";
      terminal?: boolean;
      completion?: undefined;
      errorKind?: undefined;
      reason?: undefined;
    }
  | {
      status: "error";
      terminal?: boolean;
      completion: "consumed";
      reason: TurnConsumedErrorReason;
      errorKind?: undefined;
    }
  | {
      status: "error";
      terminal?: boolean;
      errorKind: "deterministic" | "transient" | "unknown";
      completion?: undefined;
      reason?: undefined;
    }
  | {
      status: "error";
      terminal?: boolean;
      completion?: undefined;
      errorKind?: undefined;
      reason?: undefined;
    };

export type TerminalRejectionEvidence =
  | { kind: "chat_message"; messageId: string }
  | { kind: "server_terminal_record"; recordId: string };

export type HandlerRouteReceipt =
  | { kind: "owned"; mode: "queued" | "processing" }
  | { kind: "rejected"; reason: string; retryable: true };

export type StartReceipt = {
  sessionId: string;
  route: Extract<HandlerRouteReceipt, { kind: "owned" }>;
};

export type StartResult = StartReceipt | string;

export type ResumeReceipt = {
  sessionId: string;
  route: Extract<HandlerRouteReceipt, { kind: "owned" }> | null;
};

export type ResumeResult = ResumeReceipt | string;

export type DeliveryToken = {
  processingStarted(messages: SessionMessage | readonly SessionMessage[]): void;
  complete(messages: SessionMessage | readonly SessionMessage[], outcome: TurnOutcome): Promise<void>;
  retry(messages: SessionMessage | readonly SessionMessage[], reason: string): void;
  terminalRejected(
    messages: SessionMessage | readonly SessionMessage[],
    reason: string,
    evidence: TerminalRejectionEvidence,
  ): Promise<void>;
};

export function noopDeliveryToken(): DeliveryToken {
  return {
    processingStarted: () => {},
    complete: async () => {},
    retry: () => {},
    terminalRejected: async () => {},
  };
}

/** Extended context for session-oriented handlers. */
export type SessionContext = HandlerContext & {
  /** The server-side chat this session belongs to. */
  chatId: string;
  /** Refresh `lastActivity` timestamp when the provider produces activity. */
  recordProviderActivity: () => void;
  /**
   * Persist a structured session event (tool_call / error / assistant_text /
   * thinking / turn_end / usage) to the server. Assistant text DOES go through
   * here: handlers emit it as `assistant_text` events (chunked when long — see
   * `handlers/assistant-text.ts`), which are the durable, persisted record of
   * what the agent said. There is no separate chat-delivery path for it.
   */
  emitEvent: (event: SessionEvent) => void;
  /**
   * Persist a session event and resolve only after the server confirms it.
   * Business-critical events, such as Codex landing trial turn completion,
   * must await this before ACKing the inbox work that produced the turn.
   */
  emitEventConfirmed?: (event: SessionEvent) => Promise<void>;

  /**
   * Turn-completion hook the runtime calls at the end of a turn. It does NOT
   * deliver the agent's final text to chat — the per-turn final-text mirror is
   * retired (the output is captured via `assistant_text` events above, and a
   * human-visible reply must be a deliberate `chat send <human>` / `chat ask`
   * the agent issues itself). The hook only clears the turn trigger; see
   * `runtime/result-sink.ts`.
   */
  forwardResult: (text: string) => Promise<void>;

  /**
   * Deprecated delivery-reporting shim. Marks the concrete message or fused
   * batch as provider processing activity only; it no longer makes the entry
   * ACK-eligible. Built-in handlers should use the explicit DeliveryToken.
   */
  markMessagesConsumed: (messages: SessionMessage | readonly SessionMessage[]) => void;

  /**
   * Mark the concrete message or fused message batch's provider turn finished.
   * The coordinator sends one ACK-through for the last message's
   * `inboxEntryId` and settles local ledger only after server confirmation.
   */
  finishTurn: (messages: SessionMessage | readonly SessionMessage[], outcome: TurnOutcome) => Promise<void>;

  /**
   * Mark a concrete message or batch as abandoned by a retryable path
   * (abort, timeout, unknown failure). The runtime leaves the server-side
   * entries unacked; a later chat recovery or bind reset redelivers them.
   */
  retryTurn: (messages: SessionMessage | readonly SessionMessage[], reason: string) => void;

  /**
   * Drop the current live handler after it has fenced an unknown-custody
   * provider failure and marked the affected inbox work for recovery. The
   * optional session id lets recovery resume provider context from a fresh
   * handler instead of routing redelivery back into the dead one.
   */
  failSessionForRecovery?: (reason: string, sessionId?: string) => void;

  /**
   * Rebind the active runtime session to a provider-minted replacement id
   * without dropping inbox custody. Used by handlers that can safely recover a
   * stale local provider transcript/rollout by cold-starting the same inbound
   * turn under a fresh provider thread.
   */
  replaceSessionId?: (sessionId: string, reason: string) => void;

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

  /**
   * Build the full `[From: <name> · type=<human|agent> · sent=<ts>]`
   * attribution header for an inbound message — name plus, when known, the
   * sender's participant type and the message send time. Returns `""` when
   * the message has no senderId. Handlers that synthesise content (e.g. the
   * image path) call this so every inbound header is framed identically to
   * the text path. Async for the same one-time participant fetch.
   */
  formatFromHeader: (message: SessionMessage) => Promise<string>;
};

export function deliveryTokenFromSessionContext(ctx: SessionContext): DeliveryToken {
  return {
    processingStarted: (messages) => ctx.markMessagesConsumed(messages),
    complete: (messages, outcome) => ctx.finishTurn(messages, outcome),
    retry: (messages, reason) => ctx.retryTurn(messages, reason),
    terminalRejected: async (messages, reason) => {
      ctx.retryTurn(messages, `terminal_rejected_without_delivery_token:${reason}`);
    },
  };
}

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
  /** Server-stamped message provenance used by trusted attribution gates. */
  source?: string | null;
  /**
   * Server-stamped message creation time (ISO 8601). Carried so the
   * `[From: …]` attribution header can annotate when a message was sent —
   * the agent weighs recency. Optional because some synthetic/legacy
   * SessionMessage construction sites do not have it; the header omits the
   * `sent=` segment when absent.
   */
  createdAt?: string;
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
  /** Optional for compatibility with preceding context from older servers. */
  source?: string | null;
  createdAt: string;
};

/**
 * Session-oriented agent handler.
 *
 * Each handler instance owns the full lifecycle of a Claude session
 * for a single chat. The Runtime manages one handler per chatId.
 */
export type AgentHandler = {
  /** First message in a new chat. Spawn query, start consumer loop. */
  start(message: SessionMessage, ctx: SessionContext, token?: DeliveryToken): Promise<StartResult>;

  /** Message arrives for a suspended/evicted chat. Resume query from disk.
   *  `message` is undefined for admin-triggered resume (no new user input). */
  resume(
    message: SessionMessage | undefined,
    sessionId: string,
    ctx: SessionContext,
    token?: DeliveryToken,
  ): Promise<ResumeResult>;

  /** Message arrives while session is active. Push into provider-owned queue or reject. */
  inject(message: SessionMessage, token?: DeliveryToken): HandlerRouteReceipt | undefined;

  /** Idle timeout. Close query, preserve state for resume. */
  suspend(reason?: string): Promise<void>;

  /** Eviction or runtime shutdown. Same as suspend(). */
  shutdown(reason?: string): Promise<void>;
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
  /** Runtime provider for this handler slot, used for structured status payloads. */
  runtimeProvider?: RuntimeProvider;
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
