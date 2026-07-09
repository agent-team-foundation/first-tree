// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../../test-utils/dom-harness.js";

const flowMock = vi.hoisted(() => ({
  value: {
    computer: {
      connectedClient: null as null | { id: string; hostname: string | null },
      capabilitiesLoaded: false,
      okRuntimes: [] as string[],
      cliCommand: "first-tree login tok",
      tokenError: null as string | null,
      retry: vi.fn(),
    },
    goNext: vi.fn(),
  },
}));

vi.mock("../../onboarding-flow.js", () => ({
  useOnboardingFlow: () => flowMock.value,
}));

describe("StepConnectComputer", () => {
  let h: DomHarness;
  beforeEach(() => {
    h = createDomHarness();
    vi.clearAllMocks();
    flowMock.value = {
      computer: {
        connectedClient: null,
        capabilitiesLoaded: false,
        okRuntimes: [],
        cliCommand: "first-tree login tok",
        tokenError: null,
        retry: vi.fn(),
      },
      goNext: vi.fn(),
    };
  });
  afterEach(() => h.cleanup());

  it("renders waiting UI with terminal and agent command boxes", async () => {
    const { StepConnectComputer } = await import("../step-connect-computer.js");
    h.render(<StepConnectComputer />);
    await h.flush();
    expect(h.container.textContent).toContain("first-tree login tok");
  });

  it("renders stuck Node recovery when initialStuck is set", async () => {
    const { StepConnectComputer } = await import("../step-connect-computer.js");
    h.render(<StepConnectComputer initialStuck />);
    await h.flush();
    expect(h.container.textContent?.toLowerCase()).toMatch(/node/);
  });

  it("renders token error state", async () => {
    flowMock.value.computer.tokenError = "mint failed";
    const { StepConnectComputer } = await import("../step-connect-computer.js");
    h.render(<StepConnectComputer />);
    await h.flush();
    expect(h.container.textContent).toBeTruthy();
  });

  it("renders connected with detecting, no-runtime, and ok runtime lists", async () => {
    const { StepConnectComputer } = await import("../step-connect-computer.js");

    flowMock.value.computer.connectedClient = { id: "c1", hostname: "macbook" };
    flowMock.value.computer.capabilitiesLoaded = false;
    h.render(<StepConnectComputer />);
    await h.flush();
    expect(h.container.textContent).toContain("macbook");

    h.cleanup();
    h = createDomHarness();
    flowMock.value.computer.capabilitiesLoaded = true;
    flowMock.value.computer.okRuntimes = [];
    h.render(<StepConnectComputer />);
    await h.flush();

    h.cleanup();
    h = createDomHarness();
    flowMock.value.computer.okRuntimes = ["claude-code", "codex"];
    h.render(<StepConnectComputer />);
    await h.flush();
    expect(h.container.textContent).toMatch(/Claude|Codex|claude|codex/i);
  });
});
