// @vitest-environment happy-dom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../auth/require-auth.js", async () => {
  const { Outlet } = await import("react-router");
  return { RequireAuth: () => <Outlet /> };
});

vi.mock("../hooks/pulse-context.js", () => ({
  PulseProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../components/ui/toast.js", () => ({
  ToastProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../components/layout.js", async () => {
  const { Outlet } = await import("react-router");
  return {
    Layout: () => (
      <div data-testid="layout">
        <Outlet />
      </div>
    ),
  };
});

vi.mock("../pages/login.js", () => ({ LoginPage: () => <div>login page</div> }));
vi.mock("../pages/oauth-complete.js", () => ({ OAuthCompletePage: () => <div>oauth complete</div> }));
vi.mock("../pages/invite-accept.js", () => ({ InviteAcceptPage: () => <div>invite accept</div> }));
vi.mock("../pages/onboarding/onboarding-page.js", () => ({ OnboardingPage: () => <div>onboarding page</div> }));
vi.mock("../pages/workspace/index.js", () => ({ WorkspacePage: () => <div>workspace page</div> }));
vi.mock("../pages/context.js", () => ({ ContextPage: () => <div>context page</div> }));
vi.mock("../pages/team/index.js", () => ({ TeamPage: () => <div>team page</div> }));
vi.mock("../pages/mobile/shell.js", async () => {
  const { Outlet } = await import("react-router");
  return {
    MobileShell: () => (
      <div data-testid="mobile-shell">
        mobile shell
        <Outlet />
      </div>
    ),
  };
});
vi.mock("../pages/mobile/today.js", () => ({ MobileTodayPage: () => <div>mobile today</div> }));
vi.mock("../pages/mobile/chat.js", () => ({ MobileChatPage: () => <div>mobile chat</div> }));
vi.mock("../pages/mobile/team.js", () => ({ MobileTeamPage: () => <div>mobile team</div> }));
vi.mock("../pages/mobile/me.js", () => ({ MobileMePage: () => <div>mobile me</div> }));
vi.mock("../pages/settings.js", async () => {
  const { Outlet } = await import("react-router");
  return {
    SettingsLayout: () => (
      <div>
        settings layout
        <Outlet />
      </div>
    ),
  };
});
vi.mock("../pages/settings/computers.js", () => ({ SettingsComputersPage: () => <div>settings computers</div> }));
vi.mock("../pages/settings/github.js", () => ({ SettingsGithubPage: () => <div>settings github</div> }));
vi.mock("../pages/settings/onboarding.js", () => ({ SettingsOnboardingPage: () => <div>settings onboarding</div> }));
vi.mock("../pages/agent-detail.js", async () => {
  const { Outlet } = await import("react-router");
  return {
    AgentDetailPage: () => (
      <div>
        agent detail
        <Outlet />
      </div>
    ),
  };
});
vi.mock("../pages/agent-detail/profile-tab.js", () => ({ ProfileTab: () => <div>profile tab</div> }));
vi.mock("../pages/agent-detail/runtime-tab.js", () => ({ RuntimeTab: () => <div>runtime tab</div> }));
vi.mock("../pages/agent-detail/prompt-tab.js", () => ({ PromptTab: () => <div>prompt tab</div> }));
vi.mock("../pages/agent-detail/resources-tab.js", () => ({ ResourcesTab: () => <div>resources tab</div> }));
vi.mock("../pages/command-palette-preview.js", () => ({
  CommandPalettePreviewPage: () => <div>command palette preview</div>,
}));
vi.mock("../pages/styleguide-preview.js", () => ({ StyleguidePreviewPage: () => <div>styleguide preview</div> }));

let root: Root | null = null;

async function renderAppAt(path: string): Promise<string> {
  window.history.pushState({}, "", path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const { App } = await import("../app.js");
  await act(async () => {
    root?.render(<App />);
  });
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return document.body.textContent ?? "";
}

describe("App routes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    root = null;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    document.body.innerHTML = "";
  });

  it("routes public, protected, nested, preview, and redirect paths", async () => {
    expect(await renderAppAt("/login")).toContain("login page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/auth/github/complete")).toContain("oauth complete");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/invite/token-1")).toContain("invite accept");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/onboarding")).toContain("onboarding page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/agents/agent-1/tools")).toContain("profile tab");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/settings/github")).toContain("settings github");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/settings/setup")).toContain("settings onboarding");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/settings/team")).toContain("settings computers");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/admin#agents")).toContain("team page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/m")).toContain("mobile today");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/m/chat")).toContain("mobile chat");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/m/team")).toContain("mobile team");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/m/me")).toContain("mobile me");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/preview/styleguide")).toContain("styleguide preview");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/preview/command-palette")).toContain("command palette preview");
  });
});
