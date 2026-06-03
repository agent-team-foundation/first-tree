import { describe, expect, it } from "vitest";
import { STEP_COPY } from "../copy.js";

describe("STEP_COPY", () => {
  it("no step has 'outcomes' (footer removed; merged into why)", () => {
    for (const id of Object.keys(STEP_COPY) as Array<keyof typeof STEP_COPY>) {
      // outcomes was removed from the StepCopy type; any leftover string array
      // would indicate a stale entry that ships dead UI content.
      expect((STEP_COPY[id] as unknown as Record<string, unknown>).outcomes).toBeUndefined();
    }
  });
  it("kickoff's title/why stay empty (the step renders per-sub-state headings itself)", () => {
    expect(STEP_COPY.kickoff.title).toBe("");
    expect(STEP_COPY.kickoff.why).toBe("");
  });
});
