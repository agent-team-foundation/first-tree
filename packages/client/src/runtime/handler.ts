import type { AgentHubSDK } from "../sdk.js";

export type HandlerContext = {
  /** Agent identity from Server. */
  agent: { agentId: string; displayName: string | null };
  /** SDK for sending messages and managing inbox. */
  sdk: AgentHubSDK;
  /** Logger scoped to this agent slot. */
  log: (msg: string) => void;
};

/** Extended context for session-oriented handlers. */
export type SessionContext = HandlerContext & {
  /** The server-side chat this session belongs to. */
  chatId: string;
  /** Refresh `lastActivity` timestamp to prevent idle timeout. */
  touch: () => void;
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
  /** Agent working directory. */
  cwd?: string;
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

  /** Message arrives for a suspended/evicted chat. Resume query from disk. Returns claudeSessionId. */
  resume(message: SessionMessage, sessionId: string, ctx: SessionContext): Promise<string>;

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
  /** Agent's working directory. */
  cwd: string;
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
