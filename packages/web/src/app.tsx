import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router";
import { AuthProvider } from "./auth/auth-context.js";
import { RequireAuth } from "./auth/require-auth.js";
import { Layout } from "./components/layout.js";
import { AdminPage } from "./pages/admin.js";
import { AgentDetailPage } from "./pages/agent-detail.js";
import { AgentsPage } from "./pages/agents.js";
import { LoginPage } from "./pages/login.js";
import { WorkspacePage } from "./pages/workspace.js";

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
                <Route index element={<WorkspacePage />} />
                <Route path="agents" element={<AgentsPage />} />
                <Route path="agents/:uuid" element={<AgentDetailPage />} />
                <Route path="admin" element={<AdminPage />} />
              </Route>
            </Route>
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
