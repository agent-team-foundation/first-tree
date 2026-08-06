import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  AgentHandler,
  AgentIdentity,
  DeliveryToken,
  HandlerConfig,
  HandlerFactory,
  HandlerShutdownOptions,
  LoginOutcome,
  ReplayFenceEntry,
  ReplayFenceWriter,
  SessionContext,
  SessionMessage,
  TurnConsumedErrorReason,
  TurnOutcome,
} from "../runtime/contracts.js";
import * as contracts from "../runtime/contracts.js";
import * as handler from "../runtime/handler.js";

const clientSrc = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Explicit allowlist mirrored from runtime/contracts.ts — keep in sync. */
const CONTRACT_TYPE_EXPORTS = [
  "AgentHandler",
  "AgentIdentity",
  "DeliveryToken",
  "HandlerConfig",
  "HandlerFactory",
  "HandlerShutdownOptions",
  "SessionContext",
  "SessionMessage",
  "TurnConsumedErrorReason",
  "TurnOutcome",
  "LoginOutcome",
  "ReplayFenceEntry",
  "ReplayFenceWriter",
] as const;

const CONTRACT_VALUE_EXPORTS = ["noopDeliveryToken", "requireDeliveryToken"] as const;

const FORBIDDEN_CONTRACT_EXPORTS = [
  "SessionManager",
  "SessionRegistry",
  "AgentSlot",
  "AgentRuntime",
  "ReplayFenceStore",
  "ReplayFenceError",
  "HANDLER_REGISTRY",
  "createBuiltinHandlerRegistry",
] as const;

describe("runtime/contracts entry", () => {
  it("re-exports delivery token helpers with owner value identity", () => {
    expect(contracts.noopDeliveryToken).toBe(handler.noopDeliveryToken);
    expect(contracts.requireDeliveryToken).toBe(handler.requireDeliveryToken);
    const token = contracts.noopDeliveryToken();
    expect(typeof token.complete).toBe("function");
    expect(() => contracts.requireDeliveryToken(undefined, "contracts-test")).toThrow(/contracts-test/);
  });

  it("exposes only the allowlisted runtime bindings", () => {
    const valueKeys = Object.keys(contracts).sort();
    expect(valueKeys).toEqual([...CONTRACT_VALUE_EXPORTS].sort());

    for (const name of FORBIDDEN_CONTRACT_EXPORTS) {
      expect(contracts, `contracts must not export ${name}`).not.toHaveProperty(name);
    }

    const source = readFileSync(join(clientSrc, "runtime/contracts.ts"), "utf8");
    for (const name of CONTRACT_TYPE_EXPORTS) {
      expect(source, `contracts.ts must export type ${name}`).toMatch(new RegExp(`\\b${name}\\b`));
    }
    for (const name of CONTRACT_VALUE_EXPORTS) {
      expect(source, `contracts.ts must export value ${name}`).toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`));
    }
    // No barrel-style star re-exports that could leak owner modules.
    expect(source).not.toMatch(/export\s+\*\s+from/);
    expect(source).not.toMatch(/\bSessionManager\b/);
    expect(source).not.toMatch(/\bSessionRegistry\b/);
    expect(source).not.toMatch(/\bAgentSlot\b/);
    expect(source).not.toMatch(/\bAgentRuntime\b/);
    expect(source).not.toMatch(/\bReplayFenceStore\b/);
  });

  it("compiles the allowlisted type surface for provider consumers", () => {
    type _Occupancy =
      | AgentHandler
      | AgentIdentity
      | DeliveryToken
      | HandlerConfig
      | HandlerFactory
      | HandlerShutdownOptions
      | SessionContext
      | SessionMessage
      | TurnConsumedErrorReason
      | TurnOutcome
      | LoginOutcome
      | ReplayFenceEntry
      | ReplayFenceWriter
      | undefined;
    const occupied: _Occupancy[] = [undefined];
    expect(occupied).toHaveLength(1);
  });
});
