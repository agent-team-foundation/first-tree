import { describe, expect, it } from "vitest";
import { humanizeAgentType, humanizeVisibility } from "../agent-labels.js";

describe("agent-labels", () => {
  it("humanizes agent types", () => {
    expect(humanizeAgentType("human")).toBe("Human");
    expect(humanizeAgentType("agent")).toBe("Agent");
  });

  it("humanizes visibility", () => {
    expect(humanizeVisibility("private")).toBe("Private");
    expect(humanizeVisibility("organization")).toBe("Organization");
  });
});
