// @vitest-environment happy-dom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../../test-utils/dom-harness.js";

const flowMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1",
    agentDisplayName: "Nova",
    setAgentDisplayName: vi.fn(),
    visibility: "private" as const,
    setVisibility: vi.fn(),
    agentPhase: "idle" as "idle" | "creating" | "timeout",
    computer: {
      connectedClient: { id: "c1", hostname: "mac" } as null | { id: string; hostname: string | null },
      okRuntimes: ["claude-code", "codex"] as string[],
      selectedRuntime: "claude-code" as string | null,
      setSelectedRuntime: vi.fn(),
    },
    createAgent: vi.fn(),
    retryAgent: vi.fn(),
    finishLater: vi.fn(),
    goNext: vi.fn(),
    auth: { currentOrgHasPersonalAgent: false },
  },
}));

vi.mock("../../onboarding-flow.js", () => ({
  useOnboardingFlow: () => flowMock.value,
}));

vi.mock("../../../../auth/auth-context.js", () => ({
  useAuth: () => ({ currentOrgHasPersonalAgent: flowMock.value.auth.currentOrgHasPersonalAgent }),
}));

describe("StepCreateAgent", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    flowMock.value.agentPhase = "idle";
    flowMock.value.agentDisplayName = "Nova";
    flowMock.value.computer.connectedClient = { id: "c1", hostname: "mac" };
    flowMock.value.computer.okRuntimes = ["claude-code", "codex"];
    flowMock.value.computer.selectedRuntime = "claude-code";
    flowMock.value.auth.currentOrgHasPersonalAgent = false;
  });
  afterEach(() => h.cleanup());

  it("renders idle form, switches runtime, and submits create", async () => {
    const { StepCreateAgent } = await import("../step-create-agent.js");
    h.render(<StepCreateAgent />);
    await h.flush();
    expect(h.container.textContent).toBeTruthy();

    const runtimeBtn = Array.from(h.container.querySelectorAll("button")).find((b) =>
      /codex/i.test(b.textContent ?? ""),
    );
    if (runtimeBtn) {
      await act(async () => {
        runtimeBtn.click();
      });
      await h.flush();
      expect(flowMock.value.computer.setSelectedRuntime).toHaveBeenCalled();
    }

    const create = Array.from(h.container.querySelectorAll("button")).find((b) =>
      /create|continue/i.test(b.textContent ?? ""),
    );
    if (create && !(create as HTMLButtonElement).disabled) {
      await act(async () => {
        create.click();
      });
      await h.flush();
    }
  });

  it("renders creating and timeout phases with actions", async () => {
    const { StepCreateAgent } = await import("../step-create-agent.js");
    flowMock.value.agentPhase = "creating";
    h.render(<StepCreateAgent />);
    await h.flush();
    expect(h.container.textContent).toBeTruthy();

    h.cleanup();
    h = createDomHarness();
    flowMock.value.agentPhase = "timeout";
    h.render(<StepCreateAgent />);
    await h.flush();

    const keep = Array.from(h.container.querySelectorAll("button")).find((b) => /wait|keep/i.test(b.textContent ?? ""));
    const later = Array.from(h.container.querySelectorAll("button")).find((b) =>
      /later|finish/i.test(b.textContent ?? ""),
    );
    await act(async () => {
      keep?.click();
      later?.click();
    });
    await h.flush();
    expect(flowMock.value.retryAgent).toHaveBeenCalled();
    expect(flowMock.value.finishLater).toHaveBeenCalled();
  });

  it("shows disconnected computer badge when client drops", async () => {
    flowMock.value.computer.connectedClient = null;
    flowMock.value.computer.okRuntimes = [];
    flowMock.value.computer.selectedRuntime = "claude-code";
    const { StepCreateAgent } = await import("../step-create-agent.js");
    h.render(<StepCreateAgent />);
    await h.flush();
    expect(h.container.textContent).toMatch(/not ready|reconnect|unavailable|Not ready/i);
  });
});
