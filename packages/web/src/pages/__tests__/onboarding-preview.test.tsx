// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => ({ logout: () => undefined, memberships: [] }),
}));

vi.mock("../../components/ui/toast.js", () => ({
  useToast: () => ({ addToast: () => undefined }),
}));

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return { container, root };
}

async function clickByText(container: ParentNode, text: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  window.history.replaceState(null, "", "/preview/onboarding");
  sessionStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.className = "";
  vi.restoreAllMocks();
});

describe("onboarding preview review surface", () => {
  it("keeps admin flow aligned to the lightweight onboarding path", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const adminFlow = ONBOARDING_PREVIEW_SCENARIOS.filter(
      (scenario) => scenario.role === "admin" && scenario.view === "flow",
    );

    expect(adminFlow.map((scenario) => scenario.id)).toEqual([
      "admin-team",
      "admin-cc-waiting",
      "admin-ca-form",
      "admin-ko-new",
    ]);
    expect(adminFlow.map((scenario) => scenario.label)).toEqual([
      "Create team",
      "Connect computer",
      "Create agent",
      "Start chat",
    ]);
    expect(adminFlow.some((scenario) => scenario.wizard?.step === "connect-code")).toBe(false);
  });

  it("keeps preview labels aligned to product step names", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const previewText = ONBOARDING_PREVIEW_SCENARIOS.flatMap((scenario) => [scenario.label, scenario.group]).join("\n");

    expect(previewText).not.toMatch(/\bKickoff\b/);
    expect(previewText).not.toContain("Install First Tree");
    expect(previewText).not.toContain("No Context Tree finale");
  });

  it("keeps invitee focused on unique states and moves experiments out of the live flow", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const inviteeScenarios = ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.role === "invitee");
    expect(inviteeScenarios.some((scenario) => scenario.wizard?.step === "connect-computer")).toBe(false);
    expect(inviteeScenarios.some((scenario) => scenario.wizard?.step === "create-agent")).toBe(false);
    expect(inviteeScenarios.map((scenario) => scenario.id)).toEqual(
      expect.arrayContaining(["inv-link-signedout", "inv-welcome", "inv-ko-ready"]),
    );

    const liveScenarios = ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.view !== "experiments");
    expect(liveScenarios.some((scenario) => scenario.mockup)).toBe(false);
    expect(
      ONBOARDING_PREVIEW_SCENARIOS.filter((scenario) => scenario.mockup).every(
        (scenario) => scenario.view === "experiments",
      ),
    ).toBe(true);
  });

  it("keeps GitHub preview states visually distinct", async () => {
    const { ONBOARDING_PREVIEW_SCENARIOS } = await import("../onboarding-preview.js");

    const adminGithubStateIds = ONBOARDING_PREVIEW_SCENARIOS.filter(
      (scenario) => scenario.role === "admin" && scenario.group === "GitHub access states",
    ).map((scenario) => scenario.id);

    expect(adminGithubStateIds).toEqual([
      "admin-code-notinstalled",
      "admin-code-err-cantconnect",
      "admin-code-err-generic",
      "admin-code-waiting",
      "admin-code-loading",
      "admin-code-norepos",
      "admin-code-loadfailed",
      "admin-code-repos",
      "admin-code-repos-user",
    ]);
    expect(
      ONBOARDING_PREVIEW_SCENARIOS.some(
        (scenario) => /Need help|stuck|403|503/.test(scenario.label) && scenario.group === "GitHub access states",
      ),
    ).toBe(false);
  });

  it("renders GitHub access states outside the onboarding setup step shell", async () => {
    window.history.replaceState(
      null,
      "",
      "/preview/onboarding?role=admin&view=states&scenario=admin-code-notinstalled",
    );

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("GitHub access states");
    expect(container.textContent).toContain("Connect GitHub when a task needs it");
    expect(container.textContent).toContain("not a required onboarding step");
    expect(container.textContent).toContain("Install First Tree on GitHub");
    expect(container.textContent).not.toContain("Step 1 of 3");
    expect(container.textContent).not.toContain("Create a First Tree team");

    await act(async () => root.unmount());
  });

  it("uses URL params for shareable role, view, and scenario selection", async () => {
    window.history.replaceState(null, "", "/preview/onboarding?role=invitee&view=states&scenario=inv-ko-not-ready");

    const { OnboardingPreviewPage } = await import("../onboarding-preview.js");
    const { container, root } = await renderDom(
      <MemoryRouter>
        <OnboardingPreviewPage />
      </MemoryRouter>,
    );

    expect(container.textContent).toContain("State inventory");
    expect(container.textContent).toContain("Team not ready");
    expect(container.textContent).not.toContain("Waiting for computer");
    expect(container.textContent).not.toContain("Form (idle)");

    await clickByText(container, "Flow");
    expect(window.location.search).toContain("role=invitee");
    expect(window.location.search).toContain("view=flow");
    expect(window.location.search).toContain("scenario=inv-link-signedout");

    await act(async () => root.unmount());
  });
});
