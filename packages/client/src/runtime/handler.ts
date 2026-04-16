import type { FirstTreeHubSDK } from "../sdk.js";

/** Agent identity fields flowing from Server through the runtime pipeline. */
export type AgentIdentity = {
  agentId: string;
  displayName: string | null;
  type: string;
  delegateMention: string | null;
  profile: string | null;
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
  /** Append output text to the session's server-side output buffer. */
  appendOutput: (content: string) => void;
};

/** Message content extracted from an inbox entry (no entry metadata). */
export type SessionMessage = {
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
  /** Additional handler-specific config. */
  [key: string]: unknown;
};

/** Built-in handler registry. Populated by handler modules. */
const HANDLER_REGISTRY = new Map<string, HandlerFactory>();

/** Register a built-in handler type. */
export function registerHandler(type: string, factory: HandlerFactory): void {
  HANDLER_REGISTRY.set(type, factory);
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
