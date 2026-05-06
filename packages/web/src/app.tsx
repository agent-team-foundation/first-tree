import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { PulseProvider } from "./hooks/pulse-context.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { AgentsPage } from "./pages/agents.js";
import { ClientsPage } from "./pages/clients.js";
import { ContextPage } from "./pages/context.js";
import { IntegrationsPage } from "./pages/integrations.js";
import { InviteAcceptPage } from "./pages/invite-accept.js";
import { LoginPage } from "./pages/login.js";
import { MembershipPage } from "./pages/membership.js";
import { OAuthCompletePage } from "./pages/oauth-complete.js";
import { SettingsPage } from "./pages/settings.js";
import { TeamPage } from "./pages/team.js";
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
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:uuid" element={<AgentDetailPage />} />
                <Route path="clients" element={<ClientsPage />} />
                <Route path="integrations" element={<IntegrationsPage />} />
                <Route path="membership" element={<MembershipPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="settings" element={<SettingsPage />} />
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
    return <Navigate to={`/integrations${location.search}`} replace />;
  }
  return <Navigate to={`/team${location.hash}`} replace />;
}
