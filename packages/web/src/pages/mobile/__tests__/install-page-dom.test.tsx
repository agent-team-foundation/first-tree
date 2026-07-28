// @vitest-environment happy-dom

import { act } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDomHarness, type DomHarness } from "../../../test-utils/dom-harness.js";
import { MobileInstallPage } from "../install.js";

const analyticsMocks = vi.hoisted(() => ({ trackEvent: vi.fn() }));
const installMocks = vi.hoisted(() => ({
  platform: "ios" as "ios" | "android" | "other",
  mode: "ios" as "native" | "ios" | "android-manual" | null,
  install: vi.fn(async () => "accepted" as const),
}));

vi.mock("../../../analytics.js", () => analyticsMocks);
vi.mock("../install-guide-state.js", () => ({ isStandalone: () => false }));
vi.mock("../use-install-guide.js", () => ({
  useInstallPrompt: () => installMocks,
}));

describe("MobileInstallPage", () => {
  let harness: DomHarness;

  beforeEach(() => {
    harness = createDomHarness();
    analyticsMocks.trackEvent.mockReset();
    installMocks.install.mockReset();
    installMocks.install.mockResolvedValue("accepted");
    installMocks.platform = "ios";
    installMocks.mode = "ios";
  });

  afterEach(() => {
    harness.cleanup();
  });

  function render(path: string): void {
    harness.render(
      <MemoryRouter initialEntries={[path]}>
        <MobileInstallPage />
      </MemoryRouter>,
    );
  }

  it("shows the required Safari steps without promising silent installation", async () => {
    render("/m/install?source=start_chat");
    await harness.flush();

    expect(harness.container.textContent).toContain("Install First Tree");
    expect(harness.container.textContent).toContain("Tap Share in Safari");
    expect(harness.container.textContent).toContain("Choose Add to Home Screen");
    expect(harness.container.textContent).toContain("Sign in once after installation");
    expect(harness.container.textContent).not.toContain("automatically");
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("mobile_install_page_opened", {
      source: "start_chat",
      platform: "ios",
    });
  });

  it("offers one page click into Android's native prompt and records its outcome", async () => {
    installMocks.platform = "android";
    installMocks.mode = "native";
    render("/m/install?source=user_menu");
    await harness.flush();

    const button = [...harness.container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Install First Tree"),
    );
    expect(button).toBeTruthy();
    await act(async () => button?.click());
    await harness.flush();

    expect(installMocks.install).toHaveBeenCalledTimes(1);
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("mobile_install_action", {
      source: "user_menu",
      platform: "android",
      method: "native_prompt",
      outcome: "accepted",
    });
    expect(harness.container.textContent).toContain("First Tree is installed");
    expect(harness.container.textContent).toContain("Open it from your home screen");
  });

  it("recovers to Android's manual steps when the native prompt rejects", async () => {
    installMocks.platform = "android";
    installMocks.mode = "native";
    installMocks.install.mockRejectedValueOnce(new Error("stale prompt"));
    render("/m/install?source=user_menu");
    await harness.flush();

    const button = [...harness.container.querySelectorAll("button")].find((item) =>
      item.textContent?.includes("Install First Tree"),
    );
    await act(async () => button?.click());
    await harness.flush();

    expect(harness.container.textContent).toContain("Open your browser menu");
    expect(harness.container.textContent).toContain("The install prompt is not available yet.");
    expect(harness.container.textContent).not.toContain("Opening installer");
    expect(analyticsMocks.trackEvent).toHaveBeenCalledWith("mobile_install_action", {
      source: "user_menu",
      platform: "android",
      method: "native_prompt",
      outcome: "unavailable",
    });
  });

  it("renders a same-origin QR handoff when opened on desktop", async () => {
    installMocks.platform = "other";
    installMocks.mode = null;
    render("/m/install");
    await harness.flush();

    expect(harness.container.textContent).toContain("Open First Tree on your phone");
    expect(harness.container.querySelector('span[role="img"] svg')).not.toBeNull();
    expect(harness.container.textContent).toContain("only this public install link");
  });
});
