// @vitest-environment happy-dom

import type { InvitationPreview, MeMembership, OrgBrief } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const clientMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const onboardingMocks = vi.hoisted(() => ({
  markOnboardingResume: vi.fn(),
}));

const navigateMock = vi.hoisted(() => vi.fn());

const authMock = vi.hoisted(() => {
  const memberships: MeMembership[] = [];
  const currentMembership: MeMembership | null = null;
  return {
    value: {
      isAuthenticated: true,
      meLoaded: true,
      user: { id: "user-self", username: "gandy", displayName: "Gandy", avatarUrl: null },
      memberships,
      currentMembership,
      organizationId: "org-old",
      memberId: "member-self",
      role: "admin",
      agentId: "human-agent-self",
      teamDisplayName: "Old Team",
      orgHasOtherMembers: true,
      onboardingStep: "completed" as const,
      onboardingDismissedAt: null,
      onboardingCompletedAt: "2026-05-01T00:00:00.000Z",
      dismissOnboarding: vi.fn(async () => undefined),
      restoreOnboarding: vi.fn(async () => undefined),
      markOnboardingCompleted: vi.fn(async () => undefined),
      login: vi.fn(async () => undefined),
      selectOrganization: vi.fn(async () => undefined),
      refreshMe: vi.fn(async () => undefined),
      logout: vi.fn(),
    },
  };
});

vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return { ...actual, api: { ...actual.api, get: clientMocks.get, post: clientMocks.post } };
});
vi.mock("../../auth/auth-context.js", () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => authMock.value,
}));
vi.mock("../../utils/onboarding-flags.js", () => onboardingMocks);
vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

let root: Root | null = null;
let queryClient: QueryClient | null = null;
let providerAvailability = { google: true, github: true };

function preview(overrides: Partial<InvitationPreview> = {}): InvitationPreview {
  return {
    organizationId: overrides.organizationId ?? "org-new",
    organizationName: overrides.organizationName ?? "new-team",
    organizationDisplayName: overrides.organizationDisplayName ?? "New Team",
    role: overrides.role ?? "member",
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  };
}

function org(overrides: Partial<OrgBrief> = {}): OrgBrief {
  return {
    id: overrides.id ?? "org-old",
    name: overrides.name ?? "old-team",
    displayName: overrides.displayName ?? "Old Team",
    role: overrides.role ?? "admin",
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement, route = "/invite/token-1"): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const currentQueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient = currentQueryClient;
  await act(async () => {
    root?.render(
      <QueryClientProvider client={currentQueryClient}>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/invite/:token" element={element} />
            <Route path="/" element={<div>home</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
  return container;
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(rootNode: ParentNode, text: string): HTMLButtonElement {
  const button = [...rootNode.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`Missing button ${text}`);
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
  authMock.value = { ...authMock.value, isAuthenticated: true };
  authMock.value.selectOrganization.mockClear();
  navigateMock.mockReset();
  clientMocks.get.mockReset();
  providerAvailability = { google: true, github: true };
  clientMocks.post.mockReset();
  onboardingMocks.markOnboardingResume.mockReset();
  clientMocks.get.mockImplementation(async (path: string) => {
    if (path === "/bootstrap/config") return { authProviders: providerAvailability };
    if (path === "/me/organizations") return [org()];
    if (path === "/me") return { member: { organizationId: "org-old" } };
    throw new Error(`Unexpected GET ${path}`);
  });
  clientMocks.post.mockResolvedValue({
    organizationId: "org-new",
    memberId: "member-new",
    role: "member",
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: vi.fn(async () => ({
      ok: true,
      json: async () => preview(),
    })),
  });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  queryClient?.clear();
  queryClient = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("InviteAcceptPage", () => {
  it("loads a preview, warns about switching teams, joins, and resumes onboarding", async () => {
    const { InviteAcceptPage } = await import("../invite-accept.js");
    const container = await renderDom(<InviteAcceptPage />);

    await waitForText(container, "New Team");
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/invitations/token-1/preview");
    expect(container.textContent).toContain("You'll switch from");
    expect(container.textContent).toContain("Old Team");
    expect(container.textContent).toContain("Expires in 2 hours");

    await click(buttonByText(container, "Join New Team"));
    expect(clientMocks.post).toHaveBeenCalledWith("/me/organizations/join", { token: "token-1" });
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-new");
    expect(onboardingMocks.markOnboardingResume).toHaveBeenCalledWith("invite");
    expect(navigateMock).toHaveBeenCalledWith("/onboarding", { replace: true });
  });

  it("renders public OAuth and invalid invitation states", async () => {
    authMock.value = { ...authMock.value, isAuthenticated: false };
    const { InviteAcceptPage } = await import("../invite-accept.js");
    const publicPage = await renderDom(<InviteAcceptPage />);

    await waitForText(publicPage, "Continue with GitHub to join");
    const link = publicPage.querySelector<HTMLAnchorElement>("a[href^='/api/v1/auth/github/start']");
    expect(link?.href).toContain("next=%2Finvite%2Ftoken-1");
    expect(clientMocks.get).toHaveBeenCalledWith("/bootstrap/config");
    await act(async () => root?.unmount());
    root = null;

    providerAvailability = { google: true, github: false };
    const googleOnlyPage = await renderDom(<InviteAcceptPage />);
    await waitForText(googleOnlyPage, "Continue with Google to join");
    expect(googleOnlyPage.textContent).not.toContain("Continue with GitHub to join");
    await act(async () => root?.unmount());
    root = null;

    providerAvailability = { google: false, github: true };
    const githubOnlyPage = await renderDom(<InviteAcceptPage />);
    await waitForText(githubOnlyPage, "Continue with GitHub to join");
    expect(githubOnlyPage.textContent).not.toContain("Continue with Google to join");
    await act(async () => root?.unmount());
    root = null;

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    });
    const errorPage = await renderDom(<InviteAcceptPage />);
    await waitForText(errorPage, "This invitation is no longer valid");
    expect(errorPage.textContent).toContain("fresh link");
  });

  it("formats expiry hints across all display thresholds", async () => {
    const { formatExpiresHint, InviteAcceptCard, InviteAcceptError, InviteAcceptSkeleton } = await import(
      "../invite-accept.js"
    );

    expect(formatExpiresHint(null)).toBeNull();
    expect(formatExpiresHint("not-a-date")).toBeNull();
    expect(formatExpiresHint(new Date(Date.now() - 1000).toISOString())).toBeNull();
    expect(formatExpiresHint(new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString())).toBeNull();
    expect(formatExpiresHint(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString())).toEqual({
      text: "Expires in 1 day",
      urgent: false,
    });
    expect(formatExpiresHint(new Date(Date.now() + 60 * 60 * 1000).toISOString())).toEqual({
      text: "Expires in 1 hour",
      urgent: true,
    });
    expect(formatExpiresHint(new Date(Date.now() + 60_000).toISOString())).toEqual({
      text: "Expires in 1 minute",
      urgent: true,
    });

    const container = await renderDom(
      <>
        <InviteAcceptSkeleton />
        <InviteAcceptError message="Bad invitation URL" />
        <InviteAcceptCard
          preview={preview({ organizationDisplayName: "Solo Team", expiresAt: null })}
          isAuthenticated
          currentTeamName="Solo Team"
          busy
          onJoin={() => undefined}
          oauthHref="/oauth"
        />
      </>,
    );

    expect(container.textContent).toContain("Bad invitation URL");
    expect(container.textContent).toContain("Joining");
    expect(container.textContent).not.toContain("You'll switch from");
  });
});
