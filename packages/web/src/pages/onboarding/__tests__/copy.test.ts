import { describe, expect, it } from "vitest";
import { resolvePathScoped, resolveStepLabel, STEP_COPY } from "../copy.js";

describe("resolvePathScoped", () => {
  it("returns the string as-is when the same copy applies to both paths", () => {
    expect(resolvePathScoped("Connect computer", "admin")).toBe("Connect computer");
    expect(resolvePathScoped("Connect computer", "invitee")).toBe("Connect computer");
  });
  it("picks the path-specific variant when an object is given", () => {
    const v = { admin: "Start tree", invitee: "Start work" };
    expect(resolvePathScoped(v, "admin")).toBe("Start tree");
    expect(resolvePathScoped(v, "invitee")).toBe("Start work");
  });
});

describe("resolveStepLabel", () => {
  it("admin and invitee share a label for non-divergent steps", () => {
    expect(resolveStepLabel("connect-computer", "admin")).toBe("Connect computer");
    expect(resolveStepLabel("connect-computer", "invitee")).toBe("Connect computer");
    expect(resolveStepLabel("create-agent", "admin")).toBe("Create agent");
    expect(resolveStepLabel("create-agent", "invitee")).toBe("Create agent");
  });
  it("kickoff diverges: admin builds the tree, invitee just starts work", () => {
    expect(resolveStepLabel("kickoff", "admin")).toBe("Start tree");
    expect(resolveStepLabel("kickoff", "invitee")).toBe("Start work");
  });
  it("the admin's first step now uses the friendlier 'Welcome' rail label (form is still on the page)", () => {
    expect(resolveStepLabel("team", "admin")).toBe("Welcome");
    expect(resolveStepLabel("welcome", "invitee")).toBe("Welcome");
  });
});

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
