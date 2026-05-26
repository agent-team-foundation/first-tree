import { type AgentChatStatus, LIVE_ACTIVITY_STALE_MS, type LiveActivity } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { clearStaleWorking, upsertAgentStatus } from "../agent-status-view.js";

const STARTED = new Date("2026-05-25T00:00:00.000Z").getTime();
const STARTED_ISO = new Date(STARTED).toISOString();
const STALE_ISO = new Date(STARTED + LIVE_ACTIVITY_STALE_MS).toISOString();

function activity(over: Partial<LiveActivity> = {}): LiveActivity {
  return { agentId: "a1", kind: "tool_call", label: "Bash", startedAt: STARTED_ISO, staleAt: STALE_ISO, ...over };
}

function status(over: Partial<AgentChatStatus> & { agentId: string }): AgentChatStatus {
  return {
    main: "ready",
    reachable: true,
    engagement: "active",
    working: false,
    needsYou: false,
    errored: false,
    activity: null,
    ...over,
  };
}

const working = (over: Partial<AgentChatStatus> = {}): AgentChatStatus =>
  status({ agentId: "a1", main: "working", working: true, activity: activity(), ...over });

describe("clearStaleWorking", () => {
  it("returns the SAME array reference when nothing is stale", () => {
    const arr = [working()];
    expect(clearStaleWorking(arr, STARTED + 1_000)).toBe(arr); // well inside the window
  });

  it("leaves a fresh working status untouched", () => {
    const [s] = clearStaleWorking([working()], STARTED + LIVE_ACTIVITY_STALE_MS - 1);
    expect(s?.working).toBe(true);
    expect(s?.main).toBe("working");
  });

  it("clears a stale working status and re-derives main (→ ready when reachable + active)", () => {
    const [s] = clearStaleWorking([working()], STARTED + LIVE_ACTIVITY_STALE_MS + 1);
    expect(s?.working).toBe(false);
    expect(s?.activity).toBeNull();
    expect(s?.main).toBe("ready");
  });

  it("re-derives main with gating: an unreachable stale working agent → offline", () => {
    const [s] = clearStaleWorking([working({ reachable: false })], STARTED + LIVE_ACTIVITY_STALE_MS + 1);
    expect(s?.working).toBe(false);
    expect(s?.main).toBe("offline");
  });

  it("re-derives main with priority: a stale working agent that also needs-you → needs_you", () => {
    const [s] = clearStaleWorking([working({ needsYou: true })], STARTED + LIVE_ACTIVITY_STALE_MS + 1);
    expect(s?.main).toBe("needs_you");
  });

  it("falls back to startedAt + LIVE_ACTIVITY_STALE_MS when activity.staleAt is absent", () => {
    const noStaleAt = working({ activity: activity({ staleAt: undefined }) });
    expect(clearStaleWorking([noStaleAt], STARTED + LIVE_ACTIVITY_STALE_MS - 1)[0]?.working).toBe(true);
    expect(clearStaleWorking([noStaleAt], STARTED + LIVE_ACTIVITY_STALE_MS + 1)[0]?.working).toBe(false);
  });

  it("passes non-working statuses through untouched", () => {
    const arr = [status({ agentId: "a1", main: "failed", errored: true })];
    expect(clearStaleWorking(arr, STARTED + 10 * LIVE_ACTIVITY_STALE_MS)).toBe(arr);
  });
});

describe("upsertAgentStatus", () => {
  it("appends when the agent is not present", () => {
    const prev = [status({ agentId: "a1" })];
    const next = upsertAgentStatus(prev, status({ agentId: "a2", main: "working", working: true }));
    expect(next).toHaveLength(2);
    expect(next.map((s) => s.agentId)).toEqual(["a1", "a2"]);
  });

  it("replaces in place (same length, same index) when present", () => {
    const prev = [status({ agentId: "a1" }), status({ agentId: "a2" })];
    const next = upsertAgentStatus(prev, status({ agentId: "a2", main: "failed", errored: true }));
    expect(next).toHaveLength(2);
    expect(next[1]?.main).toBe("failed");
    expect(next[0]).toBe(prev[0]); // untouched entries keep their reference
  });
});
