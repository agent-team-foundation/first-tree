import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { RouteTracker } from "./analytics.js";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { ToastProvider } from "./components/ui/toast.js";
import { PulseProvider } from "./hooks/pulse-context.js";
import { useServerChannelState } from "./hooks/use-server-channel.js";
import { ProfileTab } from "./pages/agent-detail/profile-tab.js";
import { PromptTab } from "./pages/agent-detail/prompt-tab.js";
import { RepositoriesTab } from "./pages/agent-detail/repositories-tab.js";
import { ResourcesTab } from "./pages/agent-detail/resources-tab.js";
import { RuntimeTab } from "./pages/agent-detail/runtime-tab.js";
import { UsageTab } from "./pages/agent-detail/usage-tab.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { ContextPage } from "./pages/context.js";
import { DocPage } from "./pages/docs/doc-page.js";
import { DocsListPage } from "./pages/docs/docs-list-page.js";
import { InviteAcceptPage } from "./pages/invite-accept.js";
import { LoginPage } from "./pages/login.js";
import { MobileChatPage } from "./pages/mobile/chat.js";
import { MobileMePage } from "./pages/mobile/me.js";
import { MobileNowPage } from "./pages/mobile/now.js";
import { MobileShell } from "./pages/mobile/shell.js";
import { MobileTeamPage } from "./pages/mobile/team.js";
import { OAuthCompletePage } from "./pages/oauth-complete.js";
import { GithubConnectedPage } from "./pages/onboarding/github-connected.js";
import { OnboardingPage } from "./pages/onboarding/onboarding-page.js";
import { QuickstartPage } from "./pages/quickstart/quickstart-page.js";
import { SettingsComputersPage } from "./pages/settings/computers.js";
import { SettingsContextTreePage } from "./pages/settings/context-tree.js";
import { SettingsGithubPage } from "./pages/settings/github.js";
import { SettingsOnboardingPage } from "./pages/settings/onboarding.js";
import { SettingsResourcesPage } from "./pages/settings/resources.js";
import { SettingsLayout } from "./pages/settings.js";
import { TeamPage } from "./pages/team/index.js";
import { WorkspacePage } from "./pages/workspace/index.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const ContextPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/context-preview.js").then((module) => ({ default: module.ContextPreviewPage })))
  : null;

const ContextTreePreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/context-tree-preview.js").then((module) => ({ default: module.ContextTreePreviewPage })))
  : null;

const ChatRowAvatarPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/chat-row-avatar-preview.js").then((module) => ({ default: module.ChatRowAvatarPreviewPage })),
    )
  : null;

const ConversationListPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/conversation-list-preview.js").then((module) => ({
        default: module.ConversationListPreviewPage,
      })),
    )
  : null;

const ComposeStatusBarPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/compose-status-bar-preview.js").then((module) => ({
        default: module.ComposeStatusBarPreviewPage,
      })),
    )
  : null;

const ChatOfflineNoticePreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/chat-offline-notice-preview.js").then((module) => ({
        default: module.ChatOfflineNoticePreviewPage,
      })),
    )
  : null;

const RequestDockPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/request-dock-preview.js").then((module) => ({
        default: module.RequestDockPreviewPage,
      })),
    )
  : null;

const OnboardingPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/onboarding-preview.js").then((module) => ({ default: module.OnboardingPreviewPage })))
  : null;

const TeamPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/team-preview.js").then((module) => ({ default: module.TeamPreviewPage })))
  : null;

const ResourcesPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/resources-preview.js").then((module) => ({ default: module.ResourcesPreviewPage })))
  : null;

const AgentDetailPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/agent-detail-preview.js").then((module) => ({ default: module.AgentDetailPreviewPage })))
  : null;

const CommandPalettePreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/command-palette-preview.js").then((module) => ({ default: module.CommandPalettePreviewPage })),
    )
  : null;

const UserMenuPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/user-menu-preview.js").then((module) => ({ default: module.UserMenuPreviewPage })))
  : null;

const SupportMenuPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/support-menu-preview.js").then((module) => ({ default: module.SupportMenuPreviewPage })))
  : null;

const ChatSummaryPreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/chat-summary-preview.js").then((module) => ({ default: module.ChatSummaryPreviewPage })))
  : null;

const MobilePreviewPage = import.meta.env.DEV
  ? lazy(() => import("./pages/mobile-preview.js").then((module) => ({ default: module.MobilePreviewPage })))
  : null;

const InstallGuidePreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/install-guide-preview.js").then((module) => ({ default: module.InstallGuidePreviewPage })),
    )
  : null;

const TeamSwitcherPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/team-switcher-preview.js").then((module) => ({ default: module.TeamSwitcherPreviewPage })),
    )
  : null;

const SettingsGithubPreviewPage = import.meta.env.DEV
  ? lazy(() =>
      import("./pages/settings-github-preview.js").then((module) => ({ default: module.SettingsGithubPreviewPage })),
    )
  : null;

// Living design-system reference (companion to DESIGN.md). Unlike the previews
// above this ships in prod too, so it can be opened on a deployed URL — it has
// no auth-gated data, only tokens and `components/ui` primitives.
const StyleguidePreviewPage = lazy(() =>
  import("./pages/styleguide-preview.js").then((module) => ({ default: module.StyleguidePreviewPage })),
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <BrowserRouter>
            <MobileExperienceHead />
            <RouteTracker />
            <Routes>
              {/* Public routes — no auth required */}
              <Route path="/login" element={<LoginPage />} />
              {/* /signup retired — Continue with GitHub on /login covers signup. */}
              <Route path="/signup" element={<Navigate to="/login" replace />} />
              <Route path="/auth/github/complete" element={<OAuthCompletePage />} />
              {/* Public: the connect-code install popup lands here to auto-close. */}
              <Route path="/onboarding/connected" element={<GithubConnectedPage />} />
              <Route path="/invite/:token" element={<InviteAcceptPage />} />
              {ContextPreviewPage ? (
                <Route
                  path="/preview/context"
                  element={
                    <Suspense fallback={null}>
                      <ContextPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ContextTreePreviewPage ? (
                <Route
                  path="/preview/context-tree"
                  element={
                    <Suspense fallback={null}>
                      <ContextTreePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ChatRowAvatarPreviewPage ? (
                <Route
                  path="/preview/chat-row-avatar"
                  element={
                    <Suspense fallback={null}>
                      <ChatRowAvatarPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ConversationListPreviewPage ? (
                <Route
                  path="/preview/conversation-list"
                  element={
                    <Suspense fallback={null}>
                      <ConversationListPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ComposeStatusBarPreviewPage ? (
                <Route
                  path="/preview/compose-status-bar"
                  element={
                    <Suspense fallback={null}>
                      <ComposeStatusBarPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ChatOfflineNoticePreviewPage ? (
                <Route
                  path="/preview/chat-offline-notice"
                  element={
                    <Suspense fallback={null}>
                      <ChatOfflineNoticePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {RequestDockPreviewPage ? (
                <Route
                  path="/preview/request-dock"
                  element={
                    <Suspense fallback={null}>
                      <RequestDockPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {CommandPalettePreviewPage ? (
                <Route
                  path="/preview/command-palette"
                  element={
                    <Suspense fallback={null}>
                      <CommandPalettePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {UserMenuPreviewPage ? (
                <Route
                  path="/preview/user-menu"
                  element={
                    <Suspense fallback={null}>
                      <UserMenuPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {SupportMenuPreviewPage ? (
                <Route
                  path="/preview/support-menu"
                  element={
                    <Suspense fallback={null}>
                      <SupportMenuPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {TeamSwitcherPreviewPage ? (
                <Route
                  path="/preview/team-switcher"
                  element={
                    <Suspense fallback={null}>
                      <TeamSwitcherPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ChatSummaryPreviewPage ? (
                <Route
                  path="/preview/chat-summary"
                  element={
                    <Suspense fallback={null}>
                      <ChatSummaryPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {MobilePreviewPage ? (
                <Route
                  path="/preview/mobile"
                  element={
                    <Suspense fallback={null}>
                      <MobilePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {InstallGuidePreviewPage ? (
                <Route
                  path="/preview/install-guide"
                  element={
                    <Suspense fallback={null}>
                      <InstallGuidePreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {SettingsGithubPreviewPage ? (
                <Route
                  path="/preview/settings-github"
                  element={
                    <Suspense fallback={null}>
                      <SettingsGithubPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {OnboardingPreviewPage ? (
                <Route
                  path="/preview/onboarding"
                  element={
                    <Suspense fallback={null}>
                      <OnboardingPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {TeamPreviewPage ? (
                <Route
                  path="/preview/team"
                  element={
                    <Suspense fallback={null}>
                      <TeamPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {ResourcesPreviewPage ? (
                <Route
                  path="/preview/resources"
                  element={
                    <Suspense fallback={null}>
                      <ResourcesPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              {AgentDetailPreviewPage ? (
                <Route
                  path="/preview/agent-detail/*"
                  element={
                    <Suspense fallback={null}>
                      <AgentDetailPreviewPage />
                    </Suspense>
                  }
                />
              ) : null}
              <Route
                path="/preview/styleguide"
                element={
                  <Suspense fallback={null}>
                    <StyleguidePreviewPage />
                  </Suspense>
                }
              />
              {/* Auth-required pages. Onboarding is a standalone full-screen
                /onboarding route (below); the workspace root redirects users
                who haven't finished setup into it. */}
              <Route element={<RequireAuth />}>
                {/* Standalone onboarding — full-screen, outside the workspace
                    chrome. The workspace root redirects incomplete users
                    here; this route redirects back once setup is complete. */}
                <Route path="/onboarding" element={<OnboardingPage />} />
                <Route element={<MobileExperienceGate />}>
                  <Route path="m" element={<Navigate to="/m/now" replace />} />
                  <Route path="m/now" element={<MobileNowPage />} />
                  <Route path="m/chat" element={<MobileChatPage />} />
                  <Route path="m/team" element={<MobileTeamPage />} />
                  <Route path="m/me" element={<MobileMePage />} />
                  <Route path="m/*" element={<Navigate to="/m/now" replace />} />
                </Route>
                <Route
                  element={
                    <PulseProvider>
                      <Layout />
                    </PulseProvider>
                  }
                >
                  <Route index element={<WorkspaceEntry />} />
                  {/* Growth quickstart (landing-campaign trial). Lives INSIDE
                      the Layout group so the trial chat renders with full
                      workspace chrome — but as its own route, NOT the gated
                      index, so an un-onboarded trial user is not bounced to
                      /onboarding. It owns its own campaign completion semantics
                      and never writes onboarding stamps. */}
                  <Route path="quickstart" element={<QuickstartPage />} />
                  <Route path="context" element={<ContextPage />} />
                  <Route path="context/docs" element={<DocsListPage />} />
                  <Route path="context/docs/:slug" element={<DocPage />} />
                  <Route path="agents/:uuid" element={<AgentDetailPage />}>
                    <Route index element={<Navigate to="profile" replace />} />
                    <Route path="profile" element={<ProfileTab />} />
                    <Route path="usage" element={<UsageTab />} />
                    <Route path="runtime" element={<RuntimeTab />} />
                    <Route path="setup" element={<Navigate to="../runtime" replace />} />
                    <Route path="prompt" element={<PromptTab />} />
                    <Route path="tools" element={<Navigate to="../profile" replace />} />
                    <Route path="capabilities" element={<ResourcesTab />} />
                    <Route path="repositories" element={<RepositoriesTab />} />
                    {/* Legacy deep links: the tab was renamed Resources → Capabilities. */}
                    <Route path="resources" element={<Navigate to="../capabilities" replace />} />
                  </Route>

                  {/* Team — flat roster page, no sub-nav. Org-scoped admin
                      configuration (team profile / context tree / resources)
                      lives under /settings, not as a peer of the
                      people-and-agents view. */}
                  <Route path="team" element={<TeamPage />} />

                  {/* Settings master-detail. Team name editing lives in the
                      header-left TeamSwitcher, so settings only hosts setup
                      and integration/resource surfaces. */}
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="computers" replace />} />
                    <Route path="team" element={<Navigate to="/settings/computers" replace />} />
                    <Route path="context" element={<SettingsContextTreePage />} />
                    <Route path="resources" element={<SettingsResourcesPage />} />
                    <Route path="computers" element={<SettingsComputersPage />} />
                    <Route path="github" element={<SettingsGithubPage />} />
                    <Route path="onboarding" element={<SettingsOnboardingPage />} />
                    {/* Old name was "setup" — keep the redirect so existing
                        in-app links / saved bookmarks keep working. */}
                    <Route path="setup" element={<Navigate to="/settings/onboarding" replace />} />
                    <Route path="integrations" element={<Navigate to="/settings/computers" replace />} />
                  </Route>

                  {/* Backwards-compat redirects for old top-level + sub-tab routes */}
                  <Route path="agents" element={<Navigate to="/team" replace />} />
                  <Route path="clients" element={<Navigate to="/settings/computers" replace />} />
                  <Route path="integrations" element={<Navigate to="/settings/computers" replace />} />
                  <Route path="team/members" element={<Navigate to="/team" replace />} />
                  <Route path="team/agents" element={<Navigate to="/team" replace />} />
                  <Route path="team/invite" element={<Navigate to="/team" replace />} />
                  <Route path="team/settings" element={<Navigate to="/settings/computers" replace />} />
                  <Route path="admin" element={<AdminRedirect />} />
                </Route>
              </Route>
            </Routes>
          </BrowserRouter>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

type MobileExperienceState = {
  enabled: boolean;
  settled: boolean;
};

function AdminRedirect() {
  const location = useLocation();
  return <Navigate to={`/team${location.hash}`} replace />;
}

function WorkspaceEntry() {
  const location = useLocation();
  const mobileExperience = useMobileExperienceState();
  if (!mobileExperience.settled) return null;
  if (mobileExperience.enabled && shouldOpenMobileRoot(location)) {
    return <Navigate to="/m/now" replace />;
  }
  return <WorkspacePage />;
}

function shouldOpenMobileRoot(location: ReturnType<typeof useLocation>): boolean {
  if (location.pathname !== "/" || location.search || location.hash) return false;
  if (typeof window === "undefined") return false;

  const mediaQuery = window.matchMedia?.("(max-width: 47.999rem)");
  if (mediaQuery) return mediaQuery.matches;

  return window.innerWidth > 0 && window.innerWidth < 768;
}

function useMobileExperienceState(): MobileExperienceState {
  const { channel, settled: channelSettled } = useServerChannelState();
  if (!channelSettled) {
    return { enabled: false, settled: false };
  }
  return {
    enabled: channel === "dev" || channel === "staging" || channel === "prod",
    settled: true,
  };
}

function MobileExperienceGate() {
  const mobileExperience = useMobileExperienceState();
  if (!mobileExperience.settled) return null;
  if (!mobileExperience.enabled) return <Navigate to="/" replace />;

  return (
    <PulseProvider>
      <MobileShell />
    </PulseProvider>
  );
}

function MobileExperienceHead() {
  const { enabled } = useMobileExperienceState();

  useEffect(() => {
    if (!enabled || typeof document === "undefined") return;

    const elements = [
      createHeadElement("link", { rel: "manifest", href: "/manifest.webmanifest" }),
      createHeadElement("link", { rel: "apple-touch-icon", href: "/icons/apple-touch-icon.png" }),
      createHeadElement("meta", { name: "mobile-web-app-capable", content: "yes" }),
      createHeadElement("meta", { name: "apple-mobile-web-app-capable", content: "yes" }),
      createHeadElement("meta", { name: "apple-mobile-web-app-title", content: "First Tree" }),
      createHeadElement("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" }),
    ];

    for (const element of elements) {
      document.head.appendChild(element);
    }

    return () => {
      for (const element of elements) {
        element.remove();
      }
    };
  }, [enabled]);

  return null;
}

function createHeadElement(tagName: "link" | "meta", attributes: Record<string, string>): HTMLElement {
  const element = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  element.dataset.mobileExperience = "true";
  return element;
}
