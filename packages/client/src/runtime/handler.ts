import type { InboxEntryWithMessage } from "@agent-hub/shared";
import type { AgentHubSDK } from "../sdk.js";

export type HandlerContext = {
  /** Agent identity from Server. */
  agent: { agentId: string; displayName: string | null };
  /** SDK for sending messages and managing inbox. */
  sdk: AgentHubSDK;
  /** Logger scoped to this agent slot. */
  log: (msg: string) => void;
};

export type AgentHandler = {
  /** Process an incoming message. Called by Runtime for each inbox entry. */
  handle(entry: InboxEntryWithMessage, ctx: HandlerContext): Promise<void>;

  /** Cleanup when Session is recycled (idle timeout) or Runtime shuts down. */
  shutdown?(): Promise<void>;
};

/**
 * Factory function that each handler module exports.
 * Called once per Session to create a handler instance.
 */
export type HandlerFactory = (config: Record<string, unknown>) => AgentHandler;

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
