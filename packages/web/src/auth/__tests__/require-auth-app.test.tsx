// @vitest-environment happy-dom

import type { MeMembership } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../require-auth.js";

const authMock = vi.hoisted(() => ({
  value: {
    isAuthenticated: false,
    meLoaded: false,
    user: null,
    memberships: [] as MeMembership[],
    currentMembership: null as MeMembership | null,
    organizationId: null,
    memberId: null,
    role: null,
    agentId: null,
    teamDisplayName: null,
    orgHasOtherMembers: false,
    onboardingStep: null,
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
    dismissOnboarding: async () => undefined,
    restoreOnboarding: async () => undefined,
    markOnboardingCompleted: async () => undefined,
    login: async () => undefined,
    adoptTokens: async () => undefined,
    selectOrganization: async () => undefined,
    refreshMe: async () => undefined,
    logout: () => undefined,
  },
}));

vi.mock("../auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));

vi.mock("../../pages/landing/index.js", () => ({
  LandingPage: () => <div>Landing content</div>,
}));

function renderRoute(path: string): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route index element={<div>Dashboard</div>} />
            <Route path="/settings" element={<div>Settings</div>} />
          </Route>
          <Route path="/login" element={<div>Login</div>} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("RequireAuth", () => {
  it("renders public landing on unauthenticated root", () => {
    authMock.value = { ...authMock.value, isAuthenticated: false, meLoaded: false };
    expect(renderRoute("/")).toContain("landing-marketing");
  });

  it("redirects unauthenticated deep links to login", () => {
    authMock.value = { ...authMock.value, isAuthenticated: false, meLoaded: false };
    expect(renderRoute("/settings")).toBe("");
  });

  it("blocks authenticated routes until /me is loaded, then renders children", () => {
    authMock.value = { ...authMock.value, isAuthenticated: true, meLoaded: false };
    expect(renderRoute("/settings")).not.toContain("Settings");

    authMock.value = { ...authMock.value, isAuthenticated: true, meLoaded: true };
    expect(renderRoute("/settings")).toContain("Settings");
  });
});
