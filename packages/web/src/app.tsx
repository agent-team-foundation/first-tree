import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { ToastProvider } from "./components/ui/toast.js";
import { PulseProvider } from "./hooks/pulse-context.js";
import { ProfileTab } from "./pages/agent-detail/profile-tab.js";
import { PromptTab } from "./pages/agent-detail/prompt-tab.js";
import { ResourcesTab } from "./pages/agent-detail/resources-tab.js";
import { RuntimeTab } from "./pages/agent-detail/runtime-tab.js";
import { UsageTab } from "./pages/agent-detail/usage-tab.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { ContextPage } from "./pages/context.js";
import { InviteAcceptPage } from "./pages/invite-accept.js";
import { LoginPage } from "./pages/login.js";
import { OAuthCompletePage } from "./pages/oauth-complete.js";
import { BuildTreePage } from "./pages/onboarding/build-tree-page.js";
import { GithubConnectedPage } from "./pages/onboarding/github-connected.js";
import { OnboardingPage } from "./pages/onboarding/onboarding-page.js";
import { SettingsComputersPage } from "./pages/settings/computers.js";
import { SettingsContextTreePage } from "./pages/settings/context-tree.js";
import { SettingsGithubPage } from "./pages/settings/github.js";
import { SettingsOnboardingPage } from "./pages/settings/onboarding.js";
import { SettingsResourcesPage } from "./pages/settings/resources.js";
import { SettingsLayout } from "./pages/settings.js";
import { TeamPage } from "./pages/team/index.js";
import { TeamSettingsPage } from "./pages/team/settings.js";
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
                {/* Standalone "build your Context Tree" recovery — same
                    full-screen, outside-the-workspace treatment as onboarding.
                    Self-gates on tree-absence; redirects to the workspace when
                    there's nothing to recover. */}
                <Route path="/build-tree" element={<BuildTreePage />} />
                <Route
                  element={
                    <PulseProvider>
                      <Layout />
                    </PulseProvider>
                  }
                >
                  <Route index element={<WorkspacePage />} />
                  <Route path="context" element={<ContextPage />} />
                  <Route path="agents/:uuid" element={<AgentDetailPage />}>
                    <Route index element={<Navigate to="profile" replace />} />
                    <Route path="profile" element={<ProfileTab />} />
                    <Route path="usage" element={<UsageTab />} />
                    <Route path="runtime" element={<RuntimeTab />} />
                    <Route path="setup" element={<Navigate to="../runtime" replace />} />
                    <Route path="prompt" element={<PromptTab />} />
                    <Route path="tools" element={<Navigate to="../profile" replace />} />
                    <Route path="capabilities" element={<ResourcesTab />} />
                    {/* Legacy deep links: the tab was renamed Resources → Capabilities. */}
                    <Route path="resources" element={<Navigate to="../capabilities" replace />} />
                  </Route>

                  {/* Team — flat roster page, no sub-nav. Org-scoped admin
                      configuration (team profile / context tree / resources)
                      lives under /settings, not as a peer of the
                      people-and-agents view. */}
                  <Route path="team" element={<TeamPage />} />

                  {/* Settings master-detail. The org-scoped surfaces are each
                      a single cohesive page: `team` (Team profile / identity),
                      `context` (Context Tree binding), `resources` (runtime
                      resources). The rest are user-scoped. */}
                  <Route path="settings" element={<SettingsLayout />}>
                    <Route index element={<Navigate to="computers" replace />} />
                    <Route path="team" element={<TeamSettingsPage />} />
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
                  <Route path="team/settings" element={<Navigate to="/settings/team" replace />} />
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

function AdminRedirect() {
  const location = useLocation();
  return <Navigate to={`/team${location.hash}`} replace />;
}
