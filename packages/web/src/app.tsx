import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { RequireWorkspace } from "./auth/require-workspace.js";
import { Layout } from "./components/layout.js";
import { PulseProvider } from "./hooks/pulse-context.js";
import { AdminPage } from "./pages/admin.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { AgentsPage } from "./pages/agents.js";
import { AuthCallbackPage } from "./pages/auth-callback.js";
import { ClientsPage } from "./pages/clients.js";
import { InvitePage } from "./pages/invite.js";
import { LoginPage } from "./pages/login.js";
import { SettingsPage } from "./pages/settings.js";
import { SetupPage } from "./pages/setup.js";
import { SignupPage } from "./pages/signup.js";
import { WelcomeConnectPage } from "./pages/welcome-connect.js";
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
            {/* Public surface — no auth required. /login is the legacy
                username+password entry kept for self-host installs;
                /signup is the SaaS GitHub OAuth funnel. */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/signup" element={<SignupPage />} />
            <Route path="/auth/github/complete" element={<AuthCallbackPage />} />
            <Route path="/invite/:token" element={<InvitePage />} />

            {/* Authenticated but workspace-less surface: lets a freshly
                OAuthed user create or join a workspace. RequireAuth
                enforces "has a token" without demanding per-org context. */}
            <Route element={<RequireAuth />}>
              <Route path="/setup" element={<SetupPage />} />

              {/* Per-org app shell: must have at least one membership. */}
              <Route element={<RequireWorkspace />}>
                {/* Wizard pages live under /welcome/* and intentionally
                    skip the regular Layout — they're a focused, single-
                    column flow that the design doc spec'd as "screen
                    centre, no nav". */}
                <Route path="welcome/connect" element={<WelcomeConnectPage />} />
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
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
