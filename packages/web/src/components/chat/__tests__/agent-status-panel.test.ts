import { type AgentChatStatusInput, buildAgentChatStatus } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { canPauseStatus, canResumeStatus } from "../agent-status-panel.js";

const base: AgentChatStatusInput = {
  agentId: "a",
  reachable: true,
  errored: false,
  working: false,
  engagement: "none",
};
const mk = (over: Partial<AgentChatStatusInput>) => buildAgentChatStatus({ ...base, ...over });

describe("canPauseStatus — Pause only for an actively-working live session", () => {
  it("working + active session → true", () => {
    expect(canPauseStatus(mk({ working: true, engagement: "active" }))).toBe(true);
  });

  it("active session but NOT working (main=ready) → false", () => {
    // The codex blocker: an active-but-idle session must not surface Pause.
    expect(canPauseStatus(mk({ engagement: "active" }))).toBe(false);
  });

  it("working but already suspended → false (server would 409)", () => {
    expect(canPauseStatus(mk({ working: true, engagement: "suspended" }))).toBe(false);
  });

  it("offline (unreachable) → false even with an active session", () => {
    expect(canPauseStatus(mk({ reachable: false, working: true, engagement: "active" }))).toBe(false);
  });

  it("null status → false", () => {
    expect(canPauseStatus(null)).toBe(false);
  });
});

describe("canResumeStatus — Resume only for suspended sessions", () => {
  it("suspended session → true", () => {
    expect(canResumeStatus(mk({ engagement: "suspended" }))).toBe(true);
  });

  it("active session → false", () => {
    expect(canResumeStatus(mk({ engagement: "active" }))).toBe(false);
  });

  it("null status → false", () => {
    expect(canResumeStatus(null)).toBe(false);
  });
});
