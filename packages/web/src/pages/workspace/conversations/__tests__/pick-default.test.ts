import { describe, expect, it } from "vitest";
import { type PickDefaultAgent, pickDefault } from "../new-chat-draft.js";

/**
 * Pure-function tests for the New Chat default-chip seed (`pickDefault`).
 *
 * Locks the post-issue 343 / issue 342 behavior:
 *   - my-managed scope (never seed a coworker's agent — see PR 328)
 *   - PA-first, then any my-managed AI agent
 *   - humans never seed (a human "self-mirror" chip is nonsense)
 *   - suspended rows ignored
 *   - no MRU keyed on `runtimeUpdatedAt` (used to flip between clicks)
 *   - returns null when `myMemberId` is null or no managed agents exist
 */

const ME = "member-me-1";
const OTHER = "member-other-1";

/** Build an agent slice with only the fields `pickDefault` reads. */
function agent(partial: Partial<PickDefaultAgent> & Pick<PickDefaultAgent, "uuid">): PickDefaultAgent {
  return {
    type: "autonomous_agent",
    managerId: ME,
    status: "active",
    ...partial,
  };
}

describe("pickDefault", () => {
  it("returns null when myMemberId is null (logged-out or org not yet selected)", () => {
    const agents = [agent({ uuid: "a1", type: "personal_assistant" })];
    expect(pickDefault(agents, null)).toBeNull();
  });

  it("returns null when the caller manages no agents", () => {
    const agents = [
      agent({ uuid: "a1", managerId: OTHER }),
      agent({ uuid: "a2", managerId: OTHER, type: "personal_assistant" }),
    ];
    expect(pickDefault(agents, ME)).toBeNull();
  });

  it("prefers a my-managed personal_assistant", () => {
    const agents = [
      agent({ uuid: "a1" }), // autonomous, mine
      agent({ uuid: "a2", type: "personal_assistant" }), // PA, mine — winner
      agent({ uuid: "a3", type: "personal_assistant", managerId: OTHER }), // PA, NOT mine
    ];
    expect(pickDefault(agents, ME)).toBe("a2");
  });

  it("falls back to the first my-managed agent when no PA is mine", () => {
    const agents = [
      agent({ uuid: "a1", type: "personal_assistant", managerId: OTHER }), // PA but coworker's
      agent({ uuid: "a2", type: "autonomous_agent" }), // mine, winner
      agent({ uuid: "a3", type: "autonomous_agent" }), // mine, but later
    ];
    expect(pickDefault(agents, ME)).toBe("a2");
  });

  it("excludes humans even when managerId matches (humans self-manage; chip = self is nonsense)", () => {
    const agents = [
      agent({ uuid: "me-human", type: "human" }), // my human mirror
      agent({ uuid: "a1", type: "autonomous_agent" }), // my AI agent — winner
    ];
    expect(pickDefault(agents, ME)).toBe("a1");
  });

  it("returns null if the ONLY my-managed row is my human mirror", () => {
    const agents = [agent({ uuid: "me-human", type: "human" })];
    expect(pickDefault(agents, ME)).toBeNull();
  });

  it("excludes suspended agents", () => {
    const agents = [
      agent({ uuid: "a1", type: "personal_assistant", status: "suspended" }), // suspended PA — skip
      agent({ uuid: "a2", type: "autonomous_agent" }), // active AI — winner
    ];
    expect(pickDefault(agents, ME)).toBe("a2");
  });

  it("returns null when every my-managed agent is suspended", () => {
    const agents = [
      agent({ uuid: "a1", type: "personal_assistant", status: "suspended" }),
      agent({ uuid: "a2", type: "autonomous_agent", status: "suspended" }),
    ];
    expect(pickDefault(agents, ME)).toBeNull();
  });

  it("is stable across calls — does not depend on `runtimeUpdatedAt` (issue 342 regression lock)", () => {
    // Identical input set yields identical output. The pre-issue 343 implementation
    // sorted by `runtimeUpdatedAt` and could flip between adjacent calls when
    // runtime presence shifted; the new implementation has no such dependency,
    // so two passes over the same input must agree.
    const agents = [
      agent({ uuid: "a1", type: "autonomous_agent" }),
      agent({ uuid: "a2", type: "autonomous_agent" }),
      agent({ uuid: "a3", type: "personal_assistant" }),
    ];
    const first = pickDefault(agents, ME);
    const second = pickDefault(agents, ME);
    expect(first).toBe(second);
    expect(first).toBe("a3"); // PA wins
  });

  it("ignores agents managed by others mixed with my agents", () => {
    const agents = [
      agent({ uuid: "a1", managerId: OTHER }),
      agent({ uuid: "a2", managerId: OTHER, type: "personal_assistant" }),
      agent({ uuid: "a3", managerId: ME, type: "autonomous_agent" }), // winner
      agent({ uuid: "a4", managerId: OTHER }),
    ];
    expect(pickDefault(agents, ME)).toBe("a3");
  });
});
