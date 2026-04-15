import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { ActivityPage } from "./pages/activity.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { AgentsPage } from "./pages/agents.js";
import { BindingsPage } from "./pages/bindings.js";
import { ChatsPage } from "./pages/chats.js";
import { LoginPage } from "./pages/login.js";
import { MembersPage } from "./pages/members.js";
import { OverviewPage } from "./pages/overview.js";
import { SettingsPage } from "./pages/settings.js";

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
            <Route path="/login" element={<LoginPage />} />
            <Route element={<RequireAuth />}>
              <Route element={<Layout />}>
                <Route index element={<OverviewPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:uuid" element={<AgentDetailPage />} />
                <Route path="bindings" element={<BindingsPage />} />
                <Route path="chats" element={<ChatsPage />} />
                <Route path="members" element={<MembersPage />} />
                <Route path="settings" element={<SettingsPage />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
