import { type AgentChatStatusInput, buildAgentChatStatus, MAIN_STATUS_PRIORITY } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { selectAttention, statusReasonView } from "../compose-status-bar.js";

const mk = (agentId: string, over: Partial<AgentChatStatusInput>) =>
  buildAgentChatStatus({
    agentId,
    reachable: true,
    errored: false,
    working: false,
    engagement: "none",
    ...over,
  });

describe("selectAttention — the bar surfaces only actionable/active states, most urgent first", () => {
  it("keeps working / failed and drops ready / paused / offline", () => {
    const statuses = [
      mk("ready", {}),
      mk("working", { working: true }),
      mk("offline", { reachable: false }),
      mk("failed", { errored: true }),
      mk("paused", { engagement: "suspended" }),
    ];
    expect(selectAttention(statuses).map((s) => s.main)).toEqual(["failed", "working"]);
  });

  it("returns empty when every agent is quiet (ready / offline)", () => {
    expect(selectAttention([mk("r", {}), mk("o", { reachable: false })])).toEqual([]);
  });

  it("sorts by MAIN_STATUS_PRIORITY (most urgent first)", () => {
    const out = selectAttention([mk("w", { working: true }), mk("f", { errored: true })]);
    const idx = out.map((s) => MAIN_STATUS_PRIORITY.indexOf(s.main));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
  });

  it("keeps failed attention ahead of the shared participant order", () => {
    const working = mk("working", { working: true });
    const failed = mk("failed", { errored: true });

    expect(selectAttention([failed, working], ["working", "failed"]).map((s) => s.agentId)).toEqual([
      "failed",
      "working",
    ]);
  });

  it("uses the shared participant order within the same attention tier", () => {
    const workingA = mk("working-a", { working: true });
    const workingB = mk("working-b", { working: true });

    expect(selectAttention([workingA, workingB], ["working-b", "working-a"]).map((s) => s.agentId)).toEqual([
      "working-b",
      "working-a",
    ]);
  });

  it("surfaces provider retry reasons without requiring the status to be working", () => {
    const retrying = mk("retrying", {
      statusReason: {
        kind: "retrying",
        severity: "info",
        provider: "codex",
        scope: "provider_turn",
        category: "transient_transport",
        reasonCode: "provider_transient_transport",
        label: "Retrying provider",
      },
    });
    const waiting = mk("waiting", {
      statusReason: {
        kind: "waiting",
        severity: "warning",
        provider: "codex",
        scope: "session_resume",
        category: "provider_capacity",
        reasonCode: "provider_rate_limited",
        label: "Waiting for provider capacity",
      },
    });
    const terminal = mk("terminal", {
      statusReason: {
        kind: "terminal",
        severity: "error",
        provider: "codex",
        scope: "provider_turn",
        category: "unknown",
        reasonCode: "unknown_exhausted",
        label: "Provider retry exhausted",
      },
    });
    const terminalWarning = mk("terminal-warning", {
      statusReason: {
        kind: "terminal",
        severity: "warning",
        provider: "codex",
        scope: "provider_turn",
        category: "provider_capacity",
        reasonCode: "capacity_wait_required",
        label: "Provider capacity limit",
      },
    });

    expect(selectAttention([retrying, waiting, terminalWarning, terminal]).map((s) => s.agentId)).toEqual([
      "terminal",
      "terminal-warning",
      "waiting",
      "retrying",
    ]);
    expect(retrying.main).toBe("ready");
    expect(waiting.main).toBe("ready");
    expect(terminal.main).toBe("ready");
    expect(terminalWarning.main).toBe("ready");
    expect(statusReasonView(terminal)?.colorVar).toBe("var(--state-error)");
    expect(statusReasonView(terminalWarning)?.colorVar).toBe("var(--state-blocked)");
  });

  it("suppresses stale-looking terminal reasons while the agent is visibly working", () => {
    const workingWithTerminalReason = mk("working-terminal", {
      working: true,
      activity: {
        agentId: "working-terminal",
        kind: "tool_call",
        label: "Bash",
        startedAt: "2026-07-03T10:00:00.000Z",
      },
      statusReason: {
        kind: "terminal",
        severity: "error",
        provider: "codex",
        scope: "session_resume",
        category: "credential",
        reasonCode: "invalid_runtime_session",
        label: "Provider failure",
      },
    });

    expect(selectAttention([workingWithTerminalReason]).map((s) => s.agentId)).toEqual(["working-terminal"]);
    expect(statusReasonView(workingWithTerminalReason)).toBeNull();
  });
});
