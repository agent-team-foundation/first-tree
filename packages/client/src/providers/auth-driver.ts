import type { CapabilityEntry, RuntimeProvider } from "@first-tree/shared";
import type { LoginOutcome } from "../runtime/contracts.js";

/**
 * Provider-neutral contract for one in-product runtime-auth login.
 *
 * The daemon orchestrator owns the shape of the flow that is identical for
 * every browser-OAuth provider (announce, resolve, publish `pendingAuth`, run,
 * re-probe, stamp `lastAuthError`). A driver contributes only the three things
 * that genuinely differ per provider: how the login artifact resolves, how the
 * login is spawned, and which capability rows the result must refresh.
 *
 * A driver never publishes a capability entry itself and never decides retry,
 * ordering, or error policy - keeping that in the orchestrator is what lets the
 * generic dispatcher stay free of provider branches.
 */
export type RuntimeAuthDriver = {
  /**
   * Short provider word used in daemon status lines. Deliberately not the wire
   * id: the Claude Code login reads as `claude` to an operator.
   */
  readonly logLabel: string;
  /** The invocation as an operator would say it, e.g. `claude auth login`. */
  readonly loginLabel: string;
  /**
   * What is missing when resolution fails. External CLIs resolve a `binary`;
   * Claude may fall back to the SDK-bundled engine, so it reads as `CLI`.
   */
  readonly artifactLabel: string;
  /**
   * Resolve the login artifact. Returning `{ ok: false }` is the ordinary
   * "operator must install this first" path, not an exception.
   *
   * Declared as a `readonly` property (not TS method shorthand) so the
   * contract itself blocks reassignment at the type level; every production
   * driver is also `Object.freeze`d at construction so the same reassignment
   * fails at runtime regardless of how it is typed at the call site.
   */
  readonly resolveLogin: () => Promise<RuntimeAuthLoginResolution>;
  /**
   * Re-detect every capability row this login can change, in publish order.
   * Claude returns two rows when the TUI is enabled because both read the same
   * keychain credential; the other providers return their own row only.
   */
  readonly reprobe: () => Promise<readonly RuntimeAuthProbeResult[]>;
};

export type RuntimeAuthLoginResolution = { ok: true; login: RuntimeAuthLoginStart } | { ok: false; error: string };

/** Spawn the resolved login; `onAuthUrl` fires at most once with a fallback link. */
export type RuntimeAuthLoginStart = (hooks: { onAuthUrl: (url: string) => void }) => Promise<LoginOutcome>;

export type RuntimeAuthProbeResult = { provider: RuntimeProvider; entry: CapabilityEntry };
