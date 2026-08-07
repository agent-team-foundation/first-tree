/**
 * Provider-facing contracts entry for `@first-tree/client` runtime.
 *
 * This is the in-tree source of the future `@first-tree/client-runtime/contracts`
 * subpath. It is an explicit allowlist of stable symbols that provider
 * production code may depend on — not a new package, and not a temporary
 * `@first-tree/client` public subpath export.
 *
 * Values re-export the owner module bindings so identity is preserved
 * (`noopDeliveryToken` / `requireDeliveryToken` stay single-owner).
 * Do not add helpers, stores, managers, registries, or implementation classes.
 */

export type {
  AgentHandler,
  AgentIdentity,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  HandlerShutdownOptions,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
  TurnOutcome,
} from "./handler.js";
export { noopDeliveryToken, requireDeliveryToken } from "./handler.js";
export type { ReplayFenceEntry, ReplayFenceWriter } from "./replay-fence.js";
export type { LoginOutcome } from "./runtime-login.js";
