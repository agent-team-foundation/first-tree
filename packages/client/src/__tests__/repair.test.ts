import { AGENT_BIND_REJECT_REASONS } from "@agent-team-foundation/first-tree-hub-shared";
import { describe, expect, it } from "vitest";
import { decideRepairForBindReject } from "../runtime/repair.js";

/**
 * `decideRepairForBindReject` is a tiny dispatch table, but it sits on the
 * agent-bind hot path: the wrong action shape ("ignore" instead of "restart"
 * — or vice versa) silently swallows the runtime-mismatch repair, so we
 * pin the table here.
 */
describe("decideRepairForBindReject", () => {
  it("returns `restart` for runtime_provider_mismatch (P2 minimal repair)", () => {
    expect(decideRepairForBindReject(AGENT_BIND_REJECT_REASONS.RUNTIME_PROVIDER_MISMATCH)).toEqual({ kind: "restart" });
  });

  it.each([
    ["wrong_client", AGENT_BIND_REJECT_REASONS.WRONG_CLIENT],
    ["not_owned", AGENT_BIND_REJECT_REASONS.NOT_OWNED],
    ["agent_suspended", AGENT_BIND_REJECT_REASONS.AGENT_SUSPENDED],
    ["wrong_org", AGENT_BIND_REJECT_REASONS.WRONG_ORG],
    ["unknown_agent", AGENT_BIND_REJECT_REASONS.UNKNOWN_AGENT],
  ] as const)("returns `ignore` for %s (no client-side repair has been wired up)", (_label, reason) => {
    expect(decideRepairForBindReject(reason)).toEqual({ kind: "ignore" });
  });
});
