// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeScanFixHandoffFlag } from "../../../../utils/onboarding-flags.js";
import { StepStartChat } from "../step-start-chat.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// `AdminStartChat`'s repo-aware branches (ensureStartChatRepos,
// buildValueFirstBootstrap) are dormant in the live flow because
// `selectedRepoUrls` is always empty — see the comment in step-start-chat.tsx.
// These tests exercise the `!hasRepos` branch only, matching that live shape.

const flowMock = vi.hoisted(() => ({
  path: "admin" as const,
  organizationId: "org-1" as string | null,
  selectedRepoUrls: [] as string[],
  treeBindingPlan: "createBinding",
  setTreeBindingPlan: vi.fn(),
  setTreeUrl: vi.fn(),
  treeAutoDetectDone: true,
  markTreeAutoDetectDone: vi.fn(),
  completeAndEnterChat: vi.fn(async () => undefined),
}));

const resolveAgentMock = vi.hoisted(() => ({
  resolveOnboardingAgent: vi.fn(async () => ({
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
  })),
}));

const treeSetupChatMock = vi.hoisted(() => ({
  ensureStartChatRepos: vi.fn(async () => undefined),
  startOnboardingChat: vi.fn(
    async (_args: { topic: string; bootstrap: string; campaignAction?: { campaign: string; repoSlug: string } }) =>
      "chat-1",
  ),
}));

vi.mock("../../onboarding-flow.js", async () => {
  const actual = await vi.importActual<typeof import("../../onboarding-flow.js")>("../../onboarding-flow.js");
  return { ...actual, useOnboardingFlow: () => flowMock };
});
vi.mock("../../resolve-agent.js", () => resolveAgentMock);
vi.mock("../../tree-setup-chat.js", () => treeSetupChatMock);

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
  document.body.innerHTML = "";
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: createStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: window.sessionStorage });
  flowMock.organizationId = "org-1";
  flowMock.selectedRepoUrls = [];
  flowMock.treeBindingPlan = "createBinding";
  flowMock.treeAutoDetectDone = true;
  flowMock.completeAndEnterChat = vi.fn(async () => undefined);
  treeSetupChatMock.startOnboardingChat.mockResolvedValue("chat-1");
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

async function renderStep(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <StepStartChat />
      </QueryClientProvider>,
    );
  });
  return container;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
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

describe("AdminStartChat — production-scan fix handoff", () => {
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
