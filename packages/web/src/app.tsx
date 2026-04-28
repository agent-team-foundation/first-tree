import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { PulseProvider } from "./hooks/pulse-context.js";
import { AdminPage } from "./pages/admin.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { AgentsPage } from "./pages/agents.js";
import { ClientsPage } from "./pages/clients.js";
import { InviteAcceptPage } from "./pages/invite-accept.js";
import { LoginPage } from "./pages/login.js";
import { OAuthCompletePage } from "./pages/oauth-complete.js";
import { SettingsPage } from "./pages/settings.js";
import { SignupPage } from "./pages/signup.js";
import { TeamSetupPage } from "./pages/team-setup.js";
import { WelcomePage } from "./pages/welcome.js";
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
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/auth/github/complete" element={<OAuthCompletePage />} />
            <Route path="/invite/:token" element={<InviteAcceptPage />} />
            {/* Auth-required wizard / setup pages — outside the main Layout
                so they get a clean centered card UI. RequireAuth still
                bounces unauthenticated visitors to /login. */}
            <Route element={<RequireAuth />}>
              <Route path="/welcome" element={<WelcomePage />} />
              <Route path="/setup" element={<TeamSetupPage />} />
              <Route
                element={
                  <PulseProvider>
                    <Layout />
                  </PulseProvider>
                }
              >
                <Route index element={<WorkspacePage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:uuid" element={<AgentDetailPage />} />
                <Route path="clients" element={<ClientsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="admin" element={<AdminPage />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
