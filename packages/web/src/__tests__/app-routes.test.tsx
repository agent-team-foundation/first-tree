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

const serverChannelStateMock = vi.hoisted(() => ({
  channel: "prod" as "dev" | "staging" | "prod" | null,
  settled: true,
}));

vi.mock("../hooks/use-server-channel.js", () => ({
  useServerChannelState: () => serverChannelStateMock,
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
vi.mock("../pages/onboarding/github-connected.js", () => ({
  GithubConnectedPage: () => <div>github connected</div>,
}));
vi.mock("../pages/onboarding/onboarding-page.js", () => ({ OnboardingPage: () => <div>onboarding page</div> }));
vi.mock("../pages/quickstart/quickstart-page.js", () => ({ QuickstartPage: () => <div>quickstart page</div> }));
vi.mock("../pages/workspace/index.js", () => ({ WorkspacePage: () => <div>workspace page</div> }));
vi.mock("../pages/context.js", () => ({ ContextPage: () => <div>context page</div> }));
vi.mock("../pages/docs/docs-list-page.js", () => ({ DocsListPage: () => <div>docs list page</div> }));
vi.mock("../pages/docs/doc-page.js", () => ({ DocPage: () => <div>doc page</div> }));
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
vi.mock("../pages/mobile/now.js", () => ({ MobileNowPage: () => <div>mobile now</div> }));
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
vi.mock("../pages/settings/context-tree.js", () => ({ SettingsContextTreePage: () => <div>settings context</div> }));
vi.mock("../pages/settings/github.js", () => ({ SettingsGithubPage: () => <div>settings github</div> }));
vi.mock("../pages/settings/gitlab.js", () => ({ SettingsGitlabPage: () => <div>settings gitlab</div> }));
vi.mock("../pages/settings/integrations.js", async () => {
  const { Outlet } = await import("react-router");
  return {
    SettingsIntegrationsLayout: () => (
      <div>
        integrations layout
        <Outlet />
      </div>
    ),
  };
});
vi.mock("../pages/settings/onboarding.js", () => ({ SettingsOnboardingPage: () => <div>settings onboarding</div> }));
vi.mock("../pages/settings/resources.js", () => ({ SettingsResourcesPage: () => <div>settings resources</div> }));
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
vi.mock("../pages/agent-detail/repositories-tab.js", () => ({ RepositoriesTab: () => <div>repositories tab</div> }));
vi.mock("../pages/agent-detail/usage-tab.js", () => ({ UsageTab: () => <div>usage tab</div> }));
vi.mock("../pages/context-preview.js", () => ({ ContextPreviewPage: () => <div>context preview</div> }));
vi.mock("../pages/context-tree-preview.js", () => ({ ContextTreePreviewPage: () => <div>context tree preview</div> }));
vi.mock("../pages/chat-row-avatar-preview.js", () => ({
  ChatRowAvatarPreviewPage: () => <div>chat row avatar preview</div>,
}));
vi.mock("../pages/conversation-list-preview.js", () => ({
  ConversationListPreviewPage: () => <div>conversation list preview</div>,
}));
vi.mock("../pages/compose-status-bar-preview.js", () => ({
  ComposeStatusBarPreviewPage: () => <div>compose status bar preview</div>,
}));
vi.mock("../pages/chat-offline-notice-preview.js", () => ({
  ChatOfflineNoticePreviewPage: () => <div>chat offline notice preview</div>,
}));
vi.mock("../pages/request-dock-preview.js", () => ({ RequestDockPreviewPage: () => <div>request dock preview</div> }));
vi.mock("../pages/command-palette-preview.js", () => ({
  CommandPalettePreviewPage: () => <div>command palette preview</div>,
}));
vi.mock("../pages/mobile-preview.js", () => ({ MobilePreviewPage: () => <div>mobile preview page</div> }));
vi.mock("../pages/user-menu-preview.js", () => ({ UserMenuPreviewPage: () => <div>user menu preview</div> }));
vi.mock("../pages/support-menu-preview.js", () => ({ SupportMenuPreviewPage: () => <div>support menu preview</div> }));
vi.mock("../pages/chat-summary-preview.js", () => ({ ChatSummaryPreviewPage: () => <div>chat summary preview</div> }));
vi.mock("../pages/team-switcher-preview.js", () => ({
  TeamSwitcherPreviewPage: () => <div>team switcher preview</div>,
}));
vi.mock("../pages/settings-github-preview.js", () => ({
  SettingsGithubPreviewPage: () => <div>settings github preview</div>,
}));
vi.mock("../pages/onboarding-preview.js", () => ({ OnboardingPreviewPage: () => <div>onboarding preview</div> }));
vi.mock("../pages/team-preview.js", () => ({ TeamPreviewPage: () => <div>team preview</div> }));
vi.mock("../pages/resources-preview.js", () => ({ ResourcesPreviewPage: () => <div>resources preview</div> }));
vi.mock("../pages/agent-detail-preview.js", () => ({ AgentDetailPreviewPage: () => <div>agent detail preview</div> }));
vi.mock("../pages/styleguide-preview.js", () => ({ StyleguidePreviewPage: () => <div>styleguide preview</div> }));

let root: Root | null = null;

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query.includes("max-width") ? width <= 767 : width >= 768,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

async function renderAppAt(path: string, dev = true): Promise<string> {
  vi.resetModules();
  vi.stubEnv("DEV", dev);
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

async function resetRenderedApp(): Promise<void> {
  await act(async () => root?.unmount());
  document.body.innerHTML = "";
}

describe("App routes", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    root = null;
    setViewportWidth(1280);
    serverChannelStateMock.channel = "prod";
    serverChannelStateMock.settled = true;
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    document.body.innerHTML = "";
    vi.unstubAllEnvs();
  });

  it("routes public, protected, nested, preview, and redirect paths", async () => {
    expect(await renderAppAt("/")).toContain("workspace page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/login")).toContain("login page");
    await resetRenderedApp();

    expect(await renderAppAt("/auth/github/complete")).toContain("oauth complete");
    await resetRenderedApp();

    expect(await renderAppAt("/onboarding/connected")).toContain("github connected");
    await resetRenderedApp();

    expect(await renderAppAt("/invite/token-1")).toContain("invite accept");
    await resetRenderedApp();

    expect(await renderAppAt("/onboarding")).toContain("onboarding page");
    await resetRenderedApp();

    expect(await renderAppAt("/agents/agent-1/tools")).toContain("profile tab");
    await resetRenderedApp();

    expect(await renderAppAt("/settings/github")).toContain("settings github");
    await resetRenderedApp();

    expect(await renderAppAt("/settings/integrations/github")).toContain("settings github");
    await resetRenderedApp();

    expect(await renderAppAt("/settings/integrations/gitlab")).toContain("settings gitlab");
    await resetRenderedApp();

    expect(await renderAppAt("/integrations")).toContain("settings github");
    await resetRenderedApp();

    expect(await renderAppAt("/settings/setup")).toContain("settings onboarding");
    await resetRenderedApp();

    expect(await renderAppAt("/settings/context")).toContain("settings context");
    await resetRenderedApp();

    expect(await renderAppAt("/settings/resources")).toContain("settings resources");
    await resetRenderedApp();

    expect(await renderAppAt("/settings/team")).toContain("settings computers");
    await resetRenderedApp();

    expect(await renderAppAt("/quickstart")).toContain("quickstart page");
    await resetRenderedApp();

    expect(await renderAppAt("/context/docs")).toContain("docs list page");
    await resetRenderedApp();

    expect(await renderAppAt("/context/docs/setup")).toContain("doc page");
    await resetRenderedApp();

    expect(await renderAppAt("/agents/agent-1/usage")).toContain("usage tab");
    await resetRenderedApp();

    expect(await renderAppAt("/agents/agent-1/runtime")).toContain("runtime tab");
    await resetRenderedApp();

    expect(await renderAppAt("/agents/agent-1/prompt")).toContain("prompt tab");
    await resetRenderedApp();

    expect(await renderAppAt("/agents/agent-1/capabilities")).toContain("resources tab");
    await resetRenderedApp();

    expect(await renderAppAt("/agents/agent-1/repositories")).toContain("repositories tab");
    await resetRenderedApp();

    expect(await renderAppAt("/admin#agents")).toContain("team page");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/styleguide")).toContain("styleguide preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/mobile")).toContain("mobile preview page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    expect(await renderAppAt("/preview/command-palette")).toContain("command palette preview");
  });

  it("opens the mobile experience on prod", async () => {
    setViewportWidth(390);
    expect(await renderAppAt("/")).toContain("mobile now");
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe("/manifest.webmanifest");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m")).toContain("mobile now");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m/now")).toContain("mobile now");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m/chat")).toContain("mobile chat");
  });

  it("waits for the server channel before choosing the mobile or desktop shell", async () => {
    serverChannelStateMock.channel = null;
    serverChannelStateMock.settled = false;
    setViewportWidth(390);

    expect(await renderAppAt("/")).not.toContain("workspace page");
    expect(document.body.textContent ?? "").not.toContain("mobile now");
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();
  });

  it("recovers a settled unusable channel to the desktop root", async () => {
    serverChannelStateMock.channel = null;
    serverChannelStateMock.settled = true;
    setViewportWidth(390);

    expect(await renderAppAt("/")).toContain("workspace page");
    expect(document.head.querySelector('link[rel="manifest"]')).toBeNull();
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m/now")).toContain("workspace page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m/chat")).toContain("workspace page");
  });

  it("opens mobile routes, phone root, and PWA metadata on staging", async () => {
    serverChannelStateMock.channel = "staging";
    setViewportWidth(390);
    expect(await renderAppAt("/")).toContain("mobile now");
    expect(document.head.querySelector('link[rel="manifest"]')?.getAttribute("href")).toBe("/manifest.webmanifest");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m")).toContain("mobile now");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m/chat")).toContain("mobile chat");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m/team")).toContain("mobile team");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/m/me")).toContain("mobile me");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/?desktop=1")).toContain("workspace page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/?c=chat-1")).toContain("workspace page");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";

    setViewportWidth(390);
    expect(await renderAppAt("/#debug")).toContain("workspace page");
  });

  it("opens the mobile experience on dev", async () => {
    serverChannelStateMock.channel = "dev";
    setViewportWidth(390);

    expect(await renderAppAt("/m/now")).toContain("mobile now");
  });

  it("routes development preview pages and omits dev-only previews in production", async () => {
    expect(await renderAppAt("/preview/context")).toContain("context preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/context-tree")).toContain("context tree preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/chat-row-avatar")).toContain("chat row avatar preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/conversation-list")).toContain("conversation list preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/compose-status-bar")).toContain("compose status bar preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/chat-offline-notice")).toContain("chat offline notice preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/request-dock")).toContain("request dock preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/user-menu")).toContain("user menu preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/support-menu")).toContain("support menu preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/chat-summary")).toContain("chat summary preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/team-switcher")).toContain("team switcher preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/settings-github")).toContain("settings github preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/onboarding")).toContain("onboarding preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/team")).toContain("team preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/resources")).toContain("resources preview");
    await resetRenderedApp();

    expect(await renderAppAt("/preview/agent-detail/profile")).toContain("agent detail preview");
    await resetRenderedApp();

    const productionPreview = await renderAppAt("/preview/styleguide", false);
    expect(productionPreview).toContain("styleguide preview");
    expect(productionPreview).not.toContain("context preview");
  });
});
