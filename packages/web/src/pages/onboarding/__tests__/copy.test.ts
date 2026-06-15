import { describe, expect, it } from "vitest";
import { COPY, STEP_COPY } from "../copy.js";

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

describe("onboarding vocabulary (connect-agent reframe)", () => {
  // The reframe retires "runtime" from UI copy in favour of "coding agent" /
  // the tool's own name. Guard against it creeping back into the two steps
  // that used to say it.
  it("connect-computer + create-agent copy never says 'runtime'", () => {
    const cc = COPY.connectComputer;
    const ca = COPY.createAgent;
    const strings = [
      STEP_COPY["connect-computer"].title,
      STEP_COPY["create-agent"].title,
      cc.whyWaiting,
      cc.whyConnected,
      cc.waiting,
      cc.connected,
      cc.noRuntime,
      cc.detecting,
      cc.runtimeReady("Claude Code"),
      cc.runtimesReady(2),
      ...cc.stuckReasons,
      cc.troubleshootTitle,
      cc.tokenErrorTitle,
      ca.joining("Claude Code", "gandys-macbook"),
      ca.nameLabel,
      ca.creating,
      ca.creatingHint,
      ca.timeoutBody,
      `${ca.computerDisconnected.pre}${ca.computerDisconnected.link}${ca.computerDisconnected.post}`,
    ];
    for (const s of strings) {
      expect(s.toLowerCase()).not.toContain("runtime");
    }
  });

  it("names the coding agent directly once detected", () => {
    expect(COPY.connectComputer.whyWaiting).toContain("Claude Code");
    expect(COPY.connectComputer.runtimeReady("Claude Code")).toContain("Claude Code");
    expect(COPY.createAgent.joining("Claude Code", "host")).toContain("Claude Code");
  });
});
