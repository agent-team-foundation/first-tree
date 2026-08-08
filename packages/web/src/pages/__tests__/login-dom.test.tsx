// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Mutable providers state — tests override this before rendering.
const providersMock = vi.hoisted(() => ({
  state: { providers: { google: false, github: false, oidc: false }, settled: true },
}));

const authMock = vi.hoisted(() => ({
  isAuthenticated: false,
}));

vi.mock("../../hooks/use-server-channel.js", () => ({
  useAuthProviderAvailabilityState: () => providersMock.state,
}));

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock,
}));

const redirectFromStateMock = vi.hoisted(() => ({ readFromPath: vi.fn(() => null as string | null) }));

vi.mock("../../auth/redirect-from-state.js", () => ({
  readFromPath: redirectFromStateMock.readFromPath,
}));

vi.mock("../../auth/auth-analytics.js", () => ({
  beginAuthAttempt: vi.fn(),
}));

vi.mock("../mobile/install-guide-state.js", () => ({
  isStandalone: () => false,
}));

vi.mock("../../components/first-tree-logo.js", () => ({
  FirstTreeLogo: () => null,
}));

vi.mock("../../components/ui/button.js", () => ({
  Button: ({ children, asChild }: { children: ReactNode; asChild?: boolean }) =>
    asChild ? children : <button type="button">{children}</button>,
}));

import { LoginPage } from "../login.js";

let root: Root | null = null;

async function renderLogin(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>home</div>} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return container;
}

beforeEach(() => {
  document.body.innerHTML = "";
  authMock.isAuthenticated = false;
  providersMock.state = { providers: { google: false, github: false, oidc: false }, settled: true };
  redirectFromStateMock.readFromPath.mockReturnValue(null);
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("LoginPage — SSO provider display", () => {
  it("shows only 'Continue with SSO' in oidc-required mode and hides Google/GitHub", async () => {
    providersMock.state = { providers: { google: false, github: false, oidc: true }, settled: true };
    const container = await renderLogin();

    expect(container.textContent).toContain("Continue with SSO");
    expect(container.textContent).not.toContain("Continue with Google");
    expect(container.textContent).not.toContain("Continue with GitHub");

    const oidcLink = container.querySelector<HTMLAnchorElement>("a[href^='/api/v1/auth/oidc/start']");
    expect(oidcLink).not.toBeNull();
  });

  it("shows Google and GitHub but not SSO in standard mode", async () => {
    providersMock.state = { providers: { google: true, github: true, oidc: false }, settled: true };
    const container = await renderLogin();

    expect(container.textContent).toContain("Continue with Google");
    expect(container.textContent).toContain("Continue with GitHub");
    expect(container.textContent).not.toContain("Continue with SSO");
  });

  it("shows no-provider message when all providers are unavailable", async () => {
    providersMock.state = { providers: { google: false, github: false, oidc: false }, settled: true };
    const container = await renderLogin();

    expect(container.textContent).toContain("No sign-in providers are configured");
    expect(container.textContent).not.toContain("Continue with");
  });

  it("shows only SSO link with correct ?next= when redirecting to a deep link", async () => {
    providersMock.state = { providers: { google: false, github: false, oidc: true }, settled: true };
    redirectFromStateMock.readFromPath.mockReturnValue("/settings/github");

    const container = await renderLogin();

    const link = container.querySelector<HTMLAnchorElement>("a[href^='/api/v1/auth/oidc/start']");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toContain("next=");
    expect(link?.getAttribute("href")).toContain(encodeURIComponent("/settings/github"));
  });
});
