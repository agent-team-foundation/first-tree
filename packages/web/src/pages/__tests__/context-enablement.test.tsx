// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildByoSetupPrompt } from "../../lib/byo-setup-prompt.js";
import { COPY_FEEDBACK_MS } from "../../lib/use-copy-feedback.js";
import { ContextPersonalAccess, OnboardingContextPersonalAccess } from "../settings/context-enablement.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const activityMocks = vi.hoisted(() => ({ generateConnectToken: vi.fn() }));
const apiMocks = vi.hoisted(() => ({ getContextEnablementHandoff: vi.fn() }));
vi.mock("../../api/activity.js", () => activityMocks);
vi.mock("../../api/context-enablement.js", () => apiMocks);

describe("personal Context access", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(async () => undefined) },
    });
    activityMocks.generateConnectToken.mockResolvedValue({
      bootstrapCommand: "'first-tree-staging' login 'short-lived-code'",
      installerUrl: "https://example.com/install.sh",
      binName: "first-tree-staging",
    });
    apiMocks.getContextEnablementHandoff.mockResolvedValue({
      protocolVersion: 1,
      organizationId: "org-1",
      teamDisplayName: "Acme",
      role: "member",
      provider: "claude-code",
      intent: "settings",
      command: "'first-tree-staging' context enable --provider 'claude-code' --team 'org-1'",
      workingDirectoryInstruction: "Run this once from the repository root.",
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  async function render(ready: boolean) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <OnboardingContextPersonalAccess organizationId="org-1" ready={ready} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
    return [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
  }

  function promptPreview(): HTMLTextAreaElement | null {
    return document.body.querySelector<HTMLTextAreaElement>("[data-byo-setup-prompt-preview]");
  }

  async function clickAndFlush(button: HTMLButtonElement | undefined): Promise<void> {
    await act(async () => {
      button?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it("offers an optional onboarding preview without gating on this browser's Computer", async () => {
    await render(true);
    expect(host.textContent).toContain("Use Team Context in your coding agent");
    expect(host.textContent).toContain("Copy setup prompt");
    expect(host.textContent).toContain("Preview prompt");
    expect(host.textContent).not.toContain("context enable --provider");
    expect(apiMocks.getContextEnablementHandoff).not.toHaveBeenCalled();

    await clickAndFlush(buttonByText(host, "Preview prompt"));

    expect(activityMocks.generateConnectToken).toHaveBeenCalledTimes(1);
    expect(apiMocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "claude-code");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    const preview = promptPreview();
    expect(preview?.value).toContain("'first-tree-staging' login 'short-lived-code'");
    expect(preview?.value).toContain("context enable --provider 'claude-code' --team 'org-1'");
    expect(preview?.closest('[data-clarity-mask="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Nothing runs until you paste them into Claude Code or Codex.");
    expect(document.body.textContent).toContain("Contains a temporary sign-in code. Don't share it.");

    await clickAndFlush(buttonByText(document.body, "Copy prompt"));
    const copiedPrompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(copiedPrompt).toContain("'first-tree-staging' login 'short-lived-code'");
    expect(copiedPrompt).toContain("context enable --provider 'claude-code' --team 'org-1'");
    expect(copiedPrompt).toContain("First Tree Web owns onboarding completion separately.");
    expect(copiedPrompt).not.toContain("onboarding completion has been recorded");
    expect(promptPreview()).toBeNull();
    expect(host.textContent).toContain("Setup prompt copied.");
    expect(host.textContent).not.toContain("Copied — paste it into");
  });

  it("stays absent until Team Context prerequisites are ready", async () => {
    await render(false);
    expect(host.textContent).toBe("");
    expect(apiMocks.getContextEnablementHandoff).not.toHaveBeenCalled();
  });

  it("copies only the selected provider handoff", async () => {
    apiMocks.getContextEnablementHandoff.mockImplementation(
      async (_organizationId: string, provider: "claude-code" | "codex") => ({
        organizationId: "org-1",
        teamDisplayName: "Acme",
        role: "member",
        provider,
        command: `'first-tree-staging' context enable --provider '${provider}' --team 'org-1'`,
        workingDirectoryInstruction: "Run this once from the repository root.",
      }),
    );
    await render(true);

    const codex = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Codex",
    );
    await act(async () => codex?.click());
    await clickAndFlush(buttonByText(host, "Copy setup prompt"));

    expect(apiMocks.getContextEnablementHandoff).toHaveBeenCalledTimes(1);
    expect(apiMocks.getContextEnablementHandoff).toHaveBeenCalledWith("org-1", "codex");
    const copiedPrompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(copiedPrompt).toContain("--provider 'codex'");
    expect(copiedPrompt).not.toContain("--provider 'claude-code'");
    expect(copiedPrompt).toContain("/hooks");
  });

  it("does not copy an onboarding prompt after its readiness is revoked", async () => {
    let resolveHandoff:
      | ((handoff: Awaited<ReturnType<typeof apiMocks.getContextEnablementHandoff>>) => void)
      | undefined;
    apiMocks.getContextEnablementHandoff.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHandoff = resolve;
        }),
    );
    await render(true);

    const copy = buttonByText(host, "Copy setup prompt");
    await act(async () => copy?.click());
    await render(false);
    await act(async () => {
      resolveHandoff?.({
        organizationId: "org-1",
        teamDisplayName: "Acme",
        role: "member",
        provider: "claude-code",
        command: "'first-tree-staging' context enable --provider 'claude-code' --team 'org-1'",
        workingDirectoryInstruction: "Run this once from the repository root.",
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toBe("");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("surfaces an onboarding clipboard failure", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("clipboard denied"));
    await render(true);

    await clickAndFlush(buttonByText(host, "Copy setup prompt"));

    expect(document.body.textContent).toContain("Could not copy the setup prompt.");
    expect(promptPreview()).toBeNull();
  });

  it("lets the member cancel without copying or retaining the temporary prompt", async () => {
    await render(true);

    await clickAndFlush(buttonByText(host, "Preview prompt"));
    expect(promptPreview()).not.toBeNull();

    await clickAndFlush(buttonByText(document.body, "Cancel"));

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(promptPreview()).toBeNull();
    expect(host.textContent).not.toContain("Copied —");
  });

  it("rejects a server handoff for a different provider", async () => {
    apiMocks.getContextEnablementHandoff.mockResolvedValueOnce({
      organizationId: "org-1",
      teamDisplayName: "Acme",
      role: "member",
      provider: "codex",
      command: "'first-tree-staging' context enable --provider 'codex' --team 'org-1'",
      workingDirectoryInstruction: "Run this once from the repository root.",
    });
    await render(true);

    await clickAndFlush(buttonByText(host, "Copy setup prompt"));
    for (let attempt = 0; attempt < 5 && !host.textContent?.includes("Could not prepare"); attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(host.textContent).toContain("Could not prepare the setup prompt.");
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("copies one provider-neutral prompt containing both exact server-authored commands", async () => {
    apiMocks.getContextEnablementHandoff.mockImplementation(
      async (_organizationId: string, provider: "claude-code" | "codex") => ({
        organizationId: "org-1",
        teamDisplayName: "Acme",
        role: "admin",
        provider,
        command: `'first-tree-staging' context enable --provider '${provider}' --team 'org-1'`,
        workingDirectoryInstruction: "Run this once from the repository root.",
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-1" />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.textContent).toContain("Use with Claude Code or Codex");
    expect(host.textContent).toContain(
      "Open your project in Claude Code or Codex, then copy and paste the setup prompt.",
    );
    expect(host.textContent).not.toContain("context enable --provider");
    await clickAndFlush(buttonByText(host, "Preview prompt"));
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(promptPreview()?.value).toContain("If you are Claude Code:");
    expect(promptPreview()?.value).toContain("If you are Codex:");

    await clickAndFlush(buttonByText(document.body, "Copy prompt"));

    const copiedPrompt = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0];
    expect(copiedPrompt).toContain("'first-tree-staging' login 'short-lived-code'");
    expect(copiedPrompt).toContain("If you are Claude Code:");
    expect(copiedPrompt).toContain("--provider 'claude-code' --team 'org-1'");
    expect(copiedPrompt).toContain("If you are Codex:");
    expect(copiedPrompt).toContain("--provider 'codex' --team 'org-1'");
    expect(copiedPrompt).toContain("Do not run both and do not add, remove, or change command flags.");
    expect(copiedPrompt).toContain("Do not mark onboarding complete.");
    expect(host.textContent).toContain("Setup prompt copied.");
    expect(host.textContent).not.toContain("Copied — paste it into");
    expect(activityMocks.generateConnectToken).toHaveBeenCalledTimes(1);
    expect(apiMocks.getContextEnablementHandoff).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched Team handoffs instead of copying an ambiguous prompt", () => {
    expect(() =>
      buildByoSetupPrompt({
        organizationId: "org-1",
        bootstrapCommand: "bootstrap-command",
        handoffs: [
          {
            protocolVersion: 1,
            organizationId: "org-1",
            teamDisplayName: "Acme",
            role: "admin",
            provider: "claude-code",
            intent: "settings",
            command: "claude-command",
            workingDirectoryInstruction: "Run from the repository root.",
          },
          {
            protocolVersion: 1,
            organizationId: "org-2",
            teamDisplayName: "Other",
            role: "admin",
            provider: "codex",
            intent: "settings",
            command: "codex-command",
            workingDirectoryInstruction: "Run from the repository root.",
          },
        ],
        intent: "settings",
      }),
    ).toThrow("expected Team");
  });

  it("builds a one-provider onboarding artifact without exposing the other provider", () => {
    const prompt = buildByoSetupPrompt({
      organizationId: "org-1",
      bootstrapCommand: "bootstrap-command",
      handoffs: [
        {
          protocolVersion: 1,
          organizationId: "org-1",
          teamDisplayName: "Acme",
          role: "member",
          provider: "claude-code",
          intent: "onboarding",
          command: "claude-command",
          workingDirectoryInstruction: "Run from the repository root.",
        },
      ],
      intent: "onboarding",
    });

    expect(prompt).toContain("bootstrap-command");
    expect(prompt).toContain("claude-command");
    expect(prompt).not.toContain("Codex");
    expect(prompt).toContain("First Tree Web owns onboarding completion separately.");
    expect(prompt).not.toContain("confirms that onboarding is complete");
    expect(prompt).not.toContain("Do not mark onboarding complete.");
  });

  it("lets the Admin retry prompt preparation after an API failure", async () => {
    const preparePrompt = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("ready-prompt");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-1" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await clickAndFlush(buttonByText(host, "Copy setup prompt"));

    expect(host.textContent).toContain("Could not prepare the setup prompt.");
    await clickAndFlush(buttonByText(host, "Copy setup prompt"));

    expect(promptPreview()).toBeNull();
    expect(host.textContent).toContain("Setup prompt copied.");
    expect(host.textContent).not.toContain("Copied — paste it into");
    expect(preparePrompt).toHaveBeenCalledTimes(2);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("ready-prompt");
  });

  it("keeps successful copy feedback transient without adding a visible helper row", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const preparePrompt = vi.fn().mockResolvedValue("ready-prompt");

      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ContextPersonalAccess organizationId="org-1" preparePrompt={preparePrompt} />
          </QueryClientProvider>,
        );
        await Promise.resolve();
      });

      const actions = host.querySelector<HTMLElement>("[data-byo-prompt-actions]");
      const actionChildCount = actions?.childElementCount;
      await act(async () => {
        buttonByText(host, "Copy setup prompt")?.click();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(host.querySelector("svg.lucide-check")).not.toBeNull();
      expect(host.textContent).toContain("Setup prompt copied.");
      expect(actions?.childElementCount).toBe(actionChildCount);
      expect(actions?.querySelector('span.sr-only[aria-live="polite"]')?.textContent).toBe("Setup prompt copied.");
      expect(actions?.querySelector('p[aria-live="polite"]')).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(COPY_FEEDBACK_MS);
      });

      expect(host.querySelector("svg.lucide-check")).toBeNull();
      expect(host.querySelector("svg.lucide-clipboard")).not.toBeNull();
      expect(host.textContent).not.toContain("Setup prompt copied.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a reopened prompt intact when an earlier clipboard write resolves late", async () => {
    let resolveCopy: (() => void) | undefined;
    vi.mocked(navigator.clipboard.writeText).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCopy = resolve;
        }),
    );
    const preparePrompt = vi.fn().mockResolvedValueOnce("first-prompt").mockResolvedValueOnce("second-prompt");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-1" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });
    await clickAndFlush(buttonByText(host, "Preview prompt"));
    await clickAndFlush(buttonByText(document.body, "Copy prompt"));
    await clickAndFlush(buttonByText(document.body, "Cancel"));
    await clickAndFlush(buttonByText(host, "Preview prompt"));

    expect(promptPreview()?.value).toBe("second-prompt");
    await act(async () => {
      resolveCopy?.();
      await Promise.resolve();
    });

    expect(promptPreview()?.value).toBe("second-prompt");
    expect(host.textContent).not.toContain("Copied —");
  });

  it("does not copy a stale Team prompt after the Settings consumer switches Team", async () => {
    let resolveTeamA: ((prompt: string) => void) | undefined;
    const preparePrompt = vi.fn(
      (organizationId: string) =>
        new Promise<string>((resolve) => {
          if (organizationId === "org-a") resolveTeamA = resolve;
        }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-a" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
    });
    await act(async () => buttonByText(host, "Copy setup prompt")?.click());

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-b" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      resolveTeamA?.("stale-org-a-prompt");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Copy setup prompt");
    expect(promptPreview()).toBeNull();
  });

  it("does not copy a prompt after the Settings consumer unmounts", async () => {
    let resolvePrompt: ((prompt: string) => void) | undefined;
    const preparePrompt = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvePrompt = resolve;
        }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextPersonalAccess organizationId="org-a" preparePrompt={preparePrompt} />
        </QueryClientProvider>,
      );
    });
    await act(async () => buttonByText(host, "Copy setup prompt")?.click());
    await act(async () => root.render(null));
    await act(async () => {
      resolvePrompt?.("unmounted-prompt");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });
});
