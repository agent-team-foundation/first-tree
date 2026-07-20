import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isRunningInsideAgent } from "../core/agent-context.js";

/**
 * `agent create` routes on this predicate (issue #1885): inside an agent
 * session it takes the gated agent path; from a human terminal, the operator
 * path. The runtime marks an agent session with `FIRST_TREE_AGENT_ID`.
 */
describe("isRunningInsideAgent", () => {
  const original = process.env.FIRST_TREE_AGENT_ID;

  beforeEach(() => {
    delete process.env.FIRST_TREE_AGENT_ID;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.FIRST_TREE_AGENT_ID;
    else process.env.FIRST_TREE_AGENT_ID = original;
  });

  it("is true when FIRST_TREE_AGENT_ID is a non-empty string", () => {
    process.env.FIRST_TREE_AGENT_ID = "019f7e82-57a4-7145-ac48-ae969173c0c1";
    expect(isRunningInsideAgent()).toBe(true);
  });

  it("is false from a human terminal (unset)", () => {
    expect(isRunningInsideAgent()).toBe(false);
  });

  it("is false when the marker is present but empty", () => {
    process.env.FIRST_TREE_AGENT_ID = "";
    expect(isRunningInsideAgent()).toBe(false);
  });
});
