// @vitest-environment happy-dom

import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeScanFixHandoffFlag } from "../../../../utils/onboarding-flags.js";
import type { StartChatAgent } from "../../tree-setup-chat.js";
import { StepStartChat } from "../step-start-chat.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `AdminStartChat`'s repo-aware branches (ensureStartChatRepos,
// buildValueFirstBootstrap) are dormant in the live flow because
// `selectedRepoUrls` is always empty — see the comment in step-start-chat.tsx.
// These tests exercise the `!hasRepos` branch only, matching that live shape.

const flowMock = vi.hoisted(() => ({
  path: "admin" as "admin" | "invitee",
  organizationId: "org-1" as string | null,
  selectedRepoUrls: [] as string[],
  treeBindingPlan: "createBinding",
  setTreeBindingPlan: vi.fn(),
  setTreeUrl: vi.fn(),
  treeAutoDetectDone: true,
  markTreeAutoDetectDone: vi.fn(),
  completeAndEnterChat: vi.fn(async () => undefined),
  reportStepFailure: vi.fn(),
}));

const inviteeReadinessMocks = vi.hoisted(() => ({
  getContextTreeSetting: vi.fn(),
  getGithubAppInstallationExists: vi.fn(),
  listTeamResourcesForOrg: vi.fn(),
}));

const resolveAgentMock = vi.hoisted(() => ({
  resolveOnboardingAgent: vi.fn(
    async (): Promise<StartChatAgent> => ({
      uuid: "agent-1",
      name: "agent",
      displayName: "Cedar",
      type: "cedar",
      organizationId: "org-1",
      inboxId: "inbox-1",
      visibility: "org",
      runtimeProvider: "claude",
      clientId: "client-1",
      status: "active",
      avatarImageUrl: null,
    }),
  ),
}));

const treeSetupChatMock = vi.hoisted(() => ({
  ensureStartChatRepos: vi.fn(async () => undefined),
  startOnboardingChat: vi.fn(
    async (_args: { topic: string; bootstrap: string; campaignAction?: { campaign: string; repoSlug: string } }) =>
      "chat-1",
  ),
}));

function startChatAgent(overrides: Partial<StartChatAgent> = {}): StartChatAgent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "agent",
    displayName: overrides.displayName ?? "Cedar",
    type: overrides.type ?? "agent",
    organizationId: overrides.organizationId ?? "org-1",
    inboxId: overrides.inboxId ?? "inbox-1",
    visibility: overrides.visibility ?? "organization",
    runtimeProvider: overrides.runtimeProvider ?? "claude",
    clientId: overrides.clientId ?? "client-1",
    status: overrides.status ?? "active",
    avatarImageUrl: overrides.avatarImageUrl ?? null,
  };
}

vi.mock("../../onboarding-flow.js", async () => {
  const actual = await vi.importActual<typeof import("../../onboarding-flow.js")>("../../onboarding-flow.js");
  return { ...actual, useOnboardingFlow: () => flowMock };
});
vi.mock("../../resolve-agent.js", () => resolveAgentMock);
vi.mock("../../tree-setup-chat.js", () => treeSetupChatMock);
vi.mock("../../../../api/org-settings.js", () => ({
  getContextTreeSetting: inviteeReadinessMocks.getContextTreeSetting,
}));
vi.mock("../../../../api/github-app.js", () => ({
  getGithubAppInstallationExists: inviteeReadinessMocks.getGithubAppInstallationExists,
}));
vi.mock("../../../../api/resources.js", () => ({
  listTeamResourcesForOrg: inviteeReadinessMocks.listTeamResourcesForOrg,
}));

function createStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  resolveAgentMock.resolveOnboardingAgent.mockReset();
  document.body.innerHTML = "";
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  flowMock.organizationId = "org-1";
  flowMock.path = "admin";
  flowMock.selectedRepoUrls = [];
  flowMock.treeBindingPlan = "createBinding";
  flowMock.treeAutoDetectDone = true;
  flowMock.completeAndEnterChat = vi.fn(async () => undefined);
  onlineManager.setOnline(true);
  resolveAgentMock.resolveOnboardingAgent.mockResolvedValue(startChatAgent());
  inviteeReadinessMocks.getContextTreeSetting.mockResolvedValue({ repo: "https://github.com/acme/context-tree" });
  inviteeReadinessMocks.getGithubAppInstallationExists.mockResolvedValue(true);
  inviteeReadinessMocks.listTeamResourcesForOrg.mockResolvedValue([{ type: "repo", scope: "team", status: "active" }]);
  treeSetupChatMock.startOnboardingChat.mockResolvedValue("chat-1");
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  onlineManager.setOnline(true);
});

async function renderStep(
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <StepStartChat />
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function clickStart(container: HTMLElement): void {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent && b.textContent.length > 0);
  if (!button) throw new Error("expected a start button");
  act(() => {
    button.click();
  });
}

function expectCall<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected startOnboardingChat to have been called");
  return value;
}

describe("StepStartChat", () => {
  it("reveals the exact resolved agent and reuses it for kickoff", async () => {
    resolveAgentMock.resolveOnboardingAgent.mockResolvedValueOnce(
      startChatAgent({
        uuid: "agent-resumed",
        name: "resumed-agent",
        displayName: "Resumed Agent",
        inboxId: "inbox-resumed",
        runtimeProvider: "codex",
        avatarImageUrl: "https://avatars.example.test/resumed-agent.png",
      }),
    );

    const container = await renderStep();
    await flush();

    expect(container.textContent).toContain("YOUR FIRST TREE AGENT");
    expect(container.textContent).toContain("Meet Resumed Agent");
    expect(container.textContent).toContain(
      "Resumed Agent is ready to explore First Tree with you. Bring a question, a project, or a task you want to move forward.",
    );
    expect(container.textContent).toContain("You’ll open your first Chat and can start typing right away.");
    expect(container.querySelector('img[alt="Resumed Agent"]')?.getAttribute("src")).toBe(
      "https://avatars.example.test/resumed-agent.png",
    );

    clickStart(container);
    await flush();

    expect(resolveAgentMock.resolveOnboardingAgent).toHaveBeenCalledTimes(1);
    expect(treeSetupChatMock.startOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({ agent: expect.objectContaining({ uuid: "agent-resumed" }) }),
    );
    expect(container.textContent).toContain("Meet Resumed Agent");
    expect(container.textContent).toContain("Opening your first Chat…");
  });

  it("shows the same exact-agent arrival for an invitee and preserves its ready kickoff plan", async () => {
    flowMock.path = "invitee";

    const container = await renderStep();
    await flush();

    expect(container.textContent).toContain("Meet Cedar");
    expect(container.textContent).not.toContain("Context Tree");
    expect(container.textContent).not.toContain("GitHub");

    clickStart(container);
    await flush();

    expect(resolveAgentMock.resolveOnboardingAgent).toHaveBeenCalledTimes(1);
    expect(treeSetupChatMock.startOnboardingChat).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ uuid: "agent-1" }),
        joinPath: "invite",
        treeBindingPlan: "useBoundTree",
      }),
    );
  });

  it("resolves again when the same team re-enters the payoff screen", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    resolveAgentMock.resolveOnboardingAgent
      .mockResolvedValueOnce(
        startChatAgent({
          uuid: "agent-earlier-run",
          name: "earlier-run",
          displayName: "Earlier Agent",
          inboxId: "inbox-earlier-run",
          runtimeProvider: "codex",
        }),
      )
      .mockResolvedValueOnce(
        startChatAgent({
          uuid: "agent-resumed-run",
          name: "resumed-run",
          displayName: "Resumed Agent",
          inboxId: "inbox-resumed-run",
          runtimeProvider: "codex",
        }),
      );

    const first = await renderStep(queryClient);
    expect(first.textContent).toContain("Meet Earlier Agent");

    await act(async () => root?.unmount());
    root = null;
    const resumed = await renderStep(queryClient);

    expect(resolveAgentMock.resolveOnboardingAgent).toHaveBeenCalledTimes(2);
    expect(resumed.textContent).toContain("Meet Resumed Agent");
    expect(resumed.textContent).not.toContain("Meet Earlier Agent");
  });

  it("keeps the revealed target frozen across a network reconnect", async () => {
    const exactAgent = startChatAgent({ uuid: "agent-frozen", displayName: "Frozen Agent" });
    resolveAgentMock.resolveOnboardingAgent
      .mockResolvedValueOnce(exactAgent)
      .mockResolvedValueOnce(startChatAgent({ uuid: "agent-wrong", displayName: "Wrong Agent" }));

    const container = await renderStep();
    expect(container.textContent).toContain("Meet Frozen Agent");

    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await flush();

    expect(resolveAgentMock.resolveOnboardingAgent).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Meet Frozen Agent");
    expect(container.textContent).not.toContain("Meet Wrong Agent");
  });

  it("uses the deterministic identicon and keeps a long exact name readable", async () => {
    const displayName = "A very long agent name that still has to remain fully visible on a narrow onboarding screen";
    resolveAgentMock.resolveOnboardingAgent.mockResolvedValueOnce(
      startChatAgent({
        uuid: "agent-long-name",
        name: "agent-long-name",
        displayName,
        inboxId: "inbox-long-name",
        runtimeProvider: "codex",
      }),
    );

    const container = await renderStep();

    expect(container.textContent).toContain(`Meet ${displayName}`);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(`[role="img"][aria-label="${displayName}"]`)).not.toBeNull();
    expect(container.querySelector("h1")?.style.overflowWrap).toBe("anywhere");
  });

  it("uses neutral, retryable identity resolution states without a working pulse", async () => {
    resolveAgentMock.resolveOnboardingAgent.mockImplementationOnce(() => new Promise(() => {}));
    const loading = await renderStep();

    expect(loading.textContent).toContain("Finding your agent…");
    expect(loading.querySelector(".onboarding-working-dot")).toBeNull();

    await act(async () => root?.unmount());
    root = null;
    resolveAgentMock.resolveOnboardingAgent.mockRejectedValueOnce(new Error("offline"));
    const failed = await renderStep();

    expect(failed.textContent).toContain("We couldn't load your agent just now.");
    clickStart(failed);
    await flush();
    expect(failed.textContent).toContain("Meet Cedar");
  });

  it("sends the scan-fix bootstrap and topic, threads the repo slug, and clears the flag once the chat exists", async () => {
    writeScanFixHandoffFlag({
      repoUrl: "https://github.com/acme/backend",
      reportKey: "acme-backend-20260101-abcdef",
      repoSlug: "acme/backend",
    });

    const container = await renderStep();
    clickStart(container);
    await flush();

    expect(treeSetupChatMock.startOnboardingChat).toHaveBeenCalledTimes(1);
    const call = expectCall(treeSetupChatMock.startOnboardingChat.mock.calls[0]?.[0]);
    expect(call.topic).toBe("Fix production scan blockers");
    // The repo slug must thread all the way to start-chat so the server keys
    // the onboarding-path launcher for cross-path dedup (guards a dropped hop).
    expect(call.campaignAction).toEqual({ campaign: "production-scan", repoSlug: "acme/backend" });
    expect(call.bootstrap).toContain(
      "Machine-readable findings: https://report.first-tree.ai/acme-backend-20260101-abcdef.json",
    );
    expect(treeSetupChatMock.ensureStartChatRepos).not.toHaveBeenCalled();
    expect(flowMock.completeAndEnterChat).toHaveBeenCalledWith("chat-1");
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).toBeNull();
  });

  it("keeps the handoff flag when the start-chat call fails", async () => {
    writeScanFixHandoffFlag({ repoUrl: "https://github.com/acme/backend", reportKey: "acme-backend-20260101-abcdef" });
    treeSetupChatMock.startOnboardingChat.mockRejectedValueOnce(new Error("boom"));

    const container = await renderStep();
    clickStart(container);
    await flush();

    expect(flowMock.completeAndEnterChat).not.toHaveBeenCalled();
    expect(flowMock.reportStepFailure).toHaveBeenCalledWith("start_chat_failed", { step: "start-chat" });
    expect(window.sessionStorage.getItem("onboarding:campaignActionHandoff")).not.toBeNull();
  });

  it("falls back to the normal no-repo bootstrap and topic when no handoff flag is set", async () => {
    const container = await renderStep();
    clickStart(container);
    await flush();

    expect(treeSetupChatMock.startOnboardingChat).toHaveBeenCalledTimes(1);
    const call = expectCall(treeSetupChatMock.startOnboardingChat.mock.calls[0]?.[0]);
    expect(call.topic).toBe("Get started with First Tree");
    expect(call.bootstrap).toContain("Please help me get started with First Tree.");
    expect(call.bootstrap).not.toContain("production readiness scan");
    expect(flowMock.completeAndEnterChat).toHaveBeenCalledWith("chat-1");
  });
});
