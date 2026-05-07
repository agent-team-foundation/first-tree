import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { PulseProvider } from "./hooks/pulse-context.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { ContextPage } from "./pages/context.js";
import { InviteAcceptPage } from "./pages/invite-accept.js";
import { LoginPage } from "./pages/login.js";
import { OAuthCompletePage } from "./pages/oauth-complete.js";
import { SettingsComputersPage } from "./pages/settings/computers.js";
import { SettingsIntegrationsPage } from "./pages/settings/integrations.js";
import { SettingsLayout } from "./pages/settings.js";
import { TeamPage } from "./pages/team/index.js";
import { TeamSettingsPage } from "./pages/team/settings.js";
import { TeamLayout } from "./pages/team.js";
import { WorkspacePage } from "./pages/workspace/index.js";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public routes — no auth required */}
            <Route path="/login" element={<LoginPage />} />
            {/* /signup retired — Continue with GitHub on /login covers signup. */}
            <Route path="/signup" element={<Navigate to="/login" replace />} />
            <Route path="/auth/github/complete" element={<OAuthCompletePage />} />
            <Route path="/invite/:token" element={<InviteAcceptPage />} />
            {/* Auth-required pages. Onboarding is now an inline view inside
                CenterPanel (OnboardingView) — no separate /welcome route, no
                provider, no banner. */}
            <Route element={<RequireAuth />}>
              <Route
                element={
                  <PulseProvider>
                    <Layout />
                  </PulseProvider>
                }
              >
                <Route index element={<WorkspacePage />} />
                <Route path="context" element={<ContextPage />} />
                <Route path="agents/:uuid" element={<AgentDetailPage />} />

                {/* Team — Roster (default) + Settings (admin) */}
                <Route path="team" element={<TeamLayout />}>
                  <Route index element={<TeamPage />} />
                  <Route path="settings" element={<TeamSettingsPage />} />
                </Route>

                {/* Settings master-detail */}
                <Route path="settings" element={<SettingsLayout />}>
                  <Route index element={<Navigate to="computers" replace />} />
                  <Route path="computers" element={<SettingsComputersPage />} />
                  <Route path="integrations" element={<SettingsIntegrationsPage />} />
                </Route>

                {/* Backwards-compat redirects for old top-level + sub-tab routes */}
                <Route path="agents" element={<Navigate to="/team" replace />} />
                <Route path="clients" element={<Navigate to="/settings/computers" replace />} />
                <Route path="integrations" element={<Navigate to="/settings/integrations" replace />} />
                <Route path="team/members" element={<Navigate to="/team" replace />} />
                <Route path="team/agents" element={<Navigate to="/team" replace />} />
                <Route path="team/invite" element={<Navigate to="/team" replace />} />
                <Route path="admin" element={<AdminRedirect />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

function AdminRedirect() {
  const location = useLocation();
  if (location.hash === "#bindings") {
    return <Navigate to={`/settings/integrations${location.search}`} replace />;
  }
  return <Navigate to={`/team${location.hash}`} replace />;
}
