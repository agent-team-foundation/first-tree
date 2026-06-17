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
