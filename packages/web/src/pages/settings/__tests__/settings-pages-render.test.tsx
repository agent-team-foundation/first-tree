import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthValue = {
  role: "admin" | "member" | null;
  onboardingStep: string | null;
  onboardingDismissedAt: string | null;
  onboardingCompletedAt: string | null;
  dismissOnboarding: () => Promise<void>;
  restoreOnboarding: () => Promise<void>;
};

const authState: { value: AuthValue } = {
  value: {
    role: "admin",
    onboardingStep: "connect",
    onboardingDismissedAt: null,
    onboardingCompletedAt: null,
    dismissOnboarding: async () => {},
    restoreOnboarding: async () => {},
  },
};

function render(ui: ReactElement): string {
  return renderToStaticMarkup(<MemoryRouter>{ui}</MemoryRouter>);
}

async function loadPages() {
  vi.doMock("../../../auth/auth-context.js", () => ({
    useAuth: () => authState.value,
  }));
  vi.doMock("../../clients.js", () => ({
    ClientsPage: ({ embedded }: { embedded?: boolean }) =>
      createElement("div", null, `clients embedded=${String(embedded)}`),
  }));
  vi.doMock("../../github-app-installation-panel.js", () => ({
    GithubAppInstallationPanel: () => createElement("div", null, "github panel"),
  }));
  vi.doMock("../../integrations.js", () => ({
    IntegrationsPage: ({ embedded }: { embedded?: boolean }) =>
      createElement("div", null, `integrations embedded=${String(embedded)}`),
  }));
  vi.doMock("../../org-settings.js", () => ({
    OrgSettingsPage: () => createElement("div", null, "org settings panel"),
  }));

  const [computers, github, integrations, onboarding, team] = await Promise.all([
    import("../computers.js"),
    import("../github.js"),
    import("../integrations.js"),
    import("../onboarding.js"),
    import("../../team/settings.js"),
  ]);
  return {
    SettingsComputersPage: computers.SettingsComputersPage,
    SettingsGithubPage: github.SettingsGithubPage,
    SettingsIntegrationsPage: integrations.SettingsIntegrationsPage,
    SettingsOnboardingPage: onboarding.SettingsOnboardingPage,
    TeamSettingsPage: team.TeamSettingsPage,
  };
}

describe("settings pages", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    authState.value = {
      role: "admin",
      onboardingStep: "connect",
      onboardingDismissedAt: null,
      onboardingCompletedAt: null,
      dismissOnboarding: async () => {},
      restoreOnboarding: async () => {},
    };
  });

  it("renders wrapper pages in embedded mode", async () => {
    const { SettingsComputersPage, SettingsIntegrationsPage } = await loadPages();

    expect(render(<SettingsComputersPage />)).toContain("clients embedded=true");
    expect(render(<SettingsIntegrationsPage />)).toContain("integrations embedded=true");
  });

  it("renders GitHub settings loading, redirect, and admin states", async () => {
    const { SettingsGithubPage } = await loadPages();

    authState.value = { ...authState.value, role: null };
    expect(render(<SettingsGithubPage />)).toContain("Loading...");

    authState.value = { ...authState.value, role: "member" };
    expect(render(<SettingsGithubPage />)).toBe("");

    authState.value = { ...authState.value, role: "admin" };
    const html = render(<SettingsGithubPage />);
    expect(html).toContain("GitHub");
    expect(html).toContain("github panel");
  });

  it("renders onboarding recovery states", async () => {
    const { SettingsOnboardingPage } = await loadPages();

    authState.value = {
      ...authState.value,
      onboardingStep: "completed",
      onboardingDismissedAt: "2026-05-28T00:00:00.000Z",
      onboardingCompletedAt: null,
    };
    expect(render(<SettingsOnboardingPage />)).toContain("Resume setup");

    authState.value = {
      ...authState.value,
      onboardingStep: "completed",
      onboardingDismissedAt: null,
      onboardingCompletedAt: null,
    };
    const active = render(<SettingsOnboardingPage />);
    expect(active).toContain("Hide setup guide");
    expect(active).toContain("Active");

    authState.value = {
      ...authState.value,
      onboardingCompletedAt: "2026-05-28T00:00:00.000Z",
    };
    expect(render(<SettingsOnboardingPage />)).toBe("");
  });

  it("renders team settings by role", async () => {
    const { TeamSettingsPage } = await loadPages();

    authState.value = { ...authState.value, role: null };
    expect(render(<TeamSettingsPage />)).toContain("Loading...");

    authState.value = { ...authState.value, role: "member" };
    expect(render(<TeamSettingsPage />)).toContain("Repos your team");

    authState.value = { ...authState.value, role: "admin" };
    const admin = render(<TeamSettingsPage />);
    expect(admin).toContain("Identity, Context Tree, source repos");
    expect(admin).toContain("org settings panel");
  });
});
