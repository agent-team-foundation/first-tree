import { describe, expect, it } from "vitest";
import { type PickDefaultAgent, pickDefault } from "../new-chat-draft.js";

/**
 * Pure-function tests for the New Chat default-chip seed (`pickDefault`).
 *
 * Locks the issue 494 behaviour:
 *   - default = caller's own human agent's `delegateMention`
 *   - null when caller has no `delegateMention` set
 *   - null when the delegate target is missing from the org list
 *   - null when the delegate target is suspended
 *   - null when the caller's own row is missing from the org list (rare —
 *     the user's row is past the 100-row first-page cap of `useOrgAgents`)
 *   - null when `myAgentId` is null (logged-out or org not yet selected)
 */

const ME_HUMAN = "human-me";
const DELEGATE = "agent-delegate";
const OTHER = "agent-other";

/** Build an agent slice with only the fields `pickDefault` reads. */
function agent(partial: Partial<PickDefaultAgent> & Pick<PickDefaultAgent, "uuid">): PickDefaultAgent {
  return {
    type: "agent",
    managerId: null,
    status: "active",
    delegateMention: null,
    ...partial,
  };
}

describe("pickDefault", () => {
  it("returns null when myAgentId is null (logged-out or org not yet selected)", () => {
    const agents = [agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }), agent({ uuid: DELEGATE })];
    expect(pickDefault(agents, null)).toBeNull();
  });

  it("returns the human's delegateMention when set and the target is visible + active", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent" }),
      agent({ uuid: OTHER, type: "agent" }),
    ];
    expect(pickDefault(agents, ME_HUMAN)).toBe(DELEGATE);
  });

  it("returns null when the human has no delegateMention set", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: null }),
      agent({ uuid: OTHER, type: "agent" }),
    ];
    // Notably we do NOT fall back to PA / other my-managed agents —
    // the caller must declare a delegate explicitly.
    expect(pickDefault(agents, ME_HUMAN)).toBeNull();
  });

  it("returns null when the delegate target is missing from the org list", () => {
    // The delegate uuid was set sometime in the past; meanwhile the row
    // was deleted / made private / moved orgs. We refuse to seed a chip
    // that can't be confirmed against the current visible roster.
    const agents = [agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE })];
    expect(pickDefault(agents, ME_HUMAN)).toBeNull();
  });

  it("returns null when the delegate target is suspended", () => {
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent", status: "suspended" }),
    ];
    expect(pickDefault(agents, ME_HUMAN)).toBeNull();
  });

  it("returns null when the caller's own human row is missing from the org list", () => {
    // Edge: caller's human agent is past the 100-row first-page cap, so
    // we can't read its `delegateMention`. Falling back to null is
    // intentional — better an empty chip row than guessing.
    const agents = [agent({ uuid: DELEGATE, type: "agent" })];
    expect(pickDefault(agents, ME_HUMAN)).toBeNull();
  });

  it("is stable across calls — does not depend on runtime presence (issue 342 regression lock)", () => {
    // The pre-issue 343 implementation sorted by `runtimeUpdatedAt` and
    // could flip between adjacent calls when presence shifted; the
    // delegate-based default has no such dependency, so two passes
    // over the same input must agree.
    const agents = [
      agent({ uuid: ME_HUMAN, type: "human", delegateMention: DELEGATE }),
      agent({ uuid: DELEGATE, type: "agent" }),
    ];
    const first = pickDefault(agents, ME_HUMAN);
    const second = pickDefault(agents, ME_HUMAN);
    expect(first).toBe(second);
    expect(first).toBe(DELEGATE);
  });
});
