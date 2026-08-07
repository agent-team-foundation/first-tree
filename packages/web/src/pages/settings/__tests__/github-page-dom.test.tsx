// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// The GitHub round-trip return is the only logic under test here; stub the
// installation panel so the test stays focused on the `?from=context` return
// affordance. Team code access now belongs to the parent Integrations layout.
const githubAppMocks = vi.hoisted(() => ({ getGithubAppInstallation: vi.fn() }));
const orgSettingsMocks = vi.hoisted(() => ({ getGithubFeaturesSetting: vi.fn() }));
const teamAgentMocks = vi.hoisted(() => ({
  getTeamAgentCandidates: vi.fn(),
  putTeamAgentAssignment: vi.fn(),
}));
const authMock = vi.hoisted(() => ({
  value: {
    role: "admin" as string | null,
    organizationId: "org-1" as string | null,
    selectOrganization: vi.fn<(organizationId: string) => Promise<void>>(),
  },
}));
const panelMock = vi.hoisted(() => ({ props: vi.fn() }));
let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
let scrollIntoView: ReturnType<typeof vi.fn>;

vi.mock("../../../api/github-app.js", () => githubAppMocks);
vi.mock("../../../api/org-settings.js", () => orgSettingsMocks);
vi.mock("../../../api/team-agent-settings.js", () => teamAgentMocks);
vi.mock("../../../api/setup-capabilities.js", () => ({
  setupCapabilitiesQueryKey: (organizationId: string | null) => ["setup-capabilities", organizationId],
}));
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../github-app-installation-panel.js", () => ({
  GithubAppInstallationPanel: (props: unknown) => {
    panelMock.props(props);
    return <div data-testid="panel-stub">panel</div>;
  },
}));

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderAt(path: string, element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={createClient()}>{element}</QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await flush();
  return { container, root };
}

async function waitForText(container: ParentNode, text: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (container.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Expected text "${text}"\n${container.textContent ?? ""}`);
}

async function waitForSelector<T extends Element>(
  container: ParentNode,
  selector: string,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const element = container.querySelector<T>(selector);
    if (element) return element;
    await flush();
  }
  throw new Error(`Expected selector "${selector}"`);
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  window.sessionStorage.clear();
  authMock.value = {
    role: "admin",
    organizationId: "org-1",
    selectOrganization: vi.fn(async () => undefined),
  };
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  githubAppMocks.getGithubAppInstallation.mockResolvedValue(null);
  orgSettingsMocks.getGithubFeaturesSetting.mockResolvedValue({
    teamAgent: { agentUuid: null, agent: null },
  });
  teamAgentMocks.getTeamAgentCandidates.mockResolvedValue({
    items: [
      {
        uuid: "dev-agent-1",
        name: "dev-agent",
        displayName: "Dev Agent One",
        visibility: "organization",
        runtime: { health: "ready", blockers: [] },
      },
    ],
    blockers: [],
  });
  teamAgentMocks.putTeamAgentAssignment.mockResolvedValue({
    teamAgent: {
      agentUuid: "dev-agent-1",
      agent: { uuid: "dev-agent-1", name: "dev-agent", displayName: "Dev Agent One" },
    },
  });
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SettingsGithubPage — Context round-trip return", () => {
  it("offers a 'back to building' link once connected when arriving from Context", async () => {
    githubAppMocks.getGithubAppInstallation.mockResolvedValue({ installationId: 7, accountLogin: "acme" });
    const { SettingsGithubPage } = await import("../github.js");

    const { container, root } = await renderAt("/settings/github?from=context", <SettingsGithubPage />);
    await waitForText(container, "GitHub is connected");
    const back = container.querySelector('a[href="/context"]');
    expect(back).not.toBeNull();
    expect(back?.textContent).toContain("Back to building your Context Tree");

    await act(async () => root.unmount());
  });

  it("shows a quiet hint (not the return button) when arriving from Context but not yet connected", async () => {
    githubAppMocks.getGithubAppInstallation.mockResolvedValue(null);
    const { SettingsGithubPage } = await import("../github.js");

    const { container, root } = await renderAt("/settings/github?from=context", <SettingsGithubPage />);
    await waitForText(container, "then head back to build");
    expect(container.querySelector('a[href="/context"]')).toBeNull();

    await act(async () => root.unmount());
  });

  it("shows no Context return affordance (and skips the probe) when not arriving from Context", async () => {
    const { SettingsGithubPage } = await import("../github.js");

    const { container, root } = await renderAt("/settings/github", <SettingsGithubPage />);
    await waitForText(container, "panel"); // page rendered
    expect(container.querySelector('a[href="/context"]')).toBeNull();
    expect(container.textContent).not.toContain("then head back to build");
    // The page's own return probe is gated on `?from=context`. With the panel
    // stubbed, nothing queries the installation here — asserting the PAGE adds no
    // probe when not arriving from Context. (The real panel keeps its own query.)
    expect(githubAppMocks.getGithubAppInstallation).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("reopens and focuses Connection after a GitHub account-link return", async () => {
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/github?connection=github-linked", <SettingsGithubPage />);
    const connection = await waitForSelector<HTMLElement>(container, "#connection");

    expect(panelMock.props).toHaveBeenLastCalledWith(
      expect.objectContaining({ readOnly: false, initiallyOpen: true, accountLinkError: null }),
    );
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(connection);

    await act(async () => root.unmount());
  });

  it("restores the Team that started account linking before reopening Connection", async () => {
    const { rememberGithubAccountLinkReturn } = await import("../../../lib/github-account-link-return.js");
    rememberGithubAccountLinkReturn("org-original");
    authMock.value.organizationId = "org-other";
    authMock.value.selectOrganization.mockImplementation(async (organizationId) => {
      authMock.value.organizationId = organizationId;
    });
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/github?connection=github-linked", <SettingsGithubPage />);

    await waitForText(container, "panel");
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-original");
    expect(panelMock.props).toHaveBeenLastCalledWith(
      expect.objectContaining({ initiallyOpen: true, accountLinkError: null }),
    );
    expect(window.sessionStorage.getItem("settings:github:account-link-return")).toBeNull();

    await act(async () => root.unmount());
  });

  it("restores the Team that started a failed install before reopening Connection", async () => {
    const { rememberGithubInstallAttempt } = await import("../../../lib/github-install-attempt.js");
    rememberGithubInstallAttempt("org-original");
    authMock.value.organizationId = "org-other";
    authMock.value.selectOrganization.mockImplementation(async (organizationId) => {
      authMock.value.organizationId = organizationId;
    });
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt(
      "/settings/github?error=install-not-verified&flow=install",
      <SettingsGithubPage />,
    );

    await waitForText(container, "panel");
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-original");
    expect(panelMock.props).toHaveBeenLastCalledWith(
      expect.objectContaining({ initiallyOpen: true, accountLinkError: "install-not-verified" }),
    );
    expect(window.sessionStorage.getItem("settings:github:install-attempt")).toBeNull();

    await act(async () => root.unmount());
  });

  it("reopens the current Team's waiting panel after a full-page install return", async () => {
    const { rememberGithubInstallAttempt } = await import("../../../lib/github-install-attempt.js");
    rememberGithubInstallAttempt("org-1");
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/github", <SettingsGithubPage />);
    const connection = await waitForSelector<HTMLElement>(container, "#connection");

    expect(authMock.value.selectOrganization).not.toHaveBeenCalled();
    expect(panelMock.props).toHaveBeenLastCalledWith(
      expect.objectContaining({ initiallyOpen: true, accountLinkError: null }),
    );
    expect(window.sessionStorage.getItem("settings:github:install-attempt")).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(connection);

    await act(async () => root.unmount());
  });

  it("restores the Team that started a full-page install before showing its waiting panel", async () => {
    const { rememberGithubInstallAttempt } = await import("../../../lib/github-install-attempt.js");
    rememberGithubInstallAttempt("org-original");
    authMock.value.organizationId = "org-other";
    authMock.value.selectOrganization.mockImplementation(async (organizationId) => {
      authMock.value.organizationId = organizationId;
    });
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/github", <SettingsGithubPage />);

    await waitForText(container, "panel");
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-original");
    expect(panelMock.props).toHaveBeenLastCalledWith(
      expect.objectContaining({ initiallyOpen: true, accountLinkError: null }),
    );
    expect(window.sessionStorage.getItem("settings:github:install-attempt")).not.toBeNull();

    await act(async () => root.unmount());
  });

  it("keeps a failed cross-Team return recoverable without applying the marker to the current Team", async () => {
    const { rememberGithubInstallAttempt } = await import("../../../lib/github-install-attempt.js");
    rememberGithubInstallAttempt("org-original");
    authMock.value.organizationId = "org-other";
    authMock.value.selectOrganization.mockRejectedValueOnce(new Error("membership changed"));
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/github", <SettingsGithubPage />);

    await waitForText(container, "We couldn't return to the Team where you started");
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-original");
    expect(panelMock.props).toHaveBeenLastCalledWith(
      expect.objectContaining({ initiallyOpen: false, accountLinkError: null }),
    );
    expect(window.sessionStorage.getItem("settings:github:install-attempt")).not.toBeNull();

    await act(async () => root.unmount());
  });
});

describe("SettingsGithubPage — automatic handling", () => {
  it.each([
    ["#connection", "#connection", "GitHub connection"],
    ["#task-routing", "#task-routing", "GitHub automatic handling"],
  ])("positions and focuses the %s section", async (hash, selector, label) => {
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt(`/settings/integrations/github${hash}`, <SettingsGithubPage />);
    const target = await waitForSelector<HTMLElement>(container, selector);

    expect(target.getAttribute("aria-label")).toBe(label);
    expect(target.tabIndex).toBe(-1);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(target);
    await act(async () => root.unmount());
  });

  it("places GitHub Task Agent directly below the GitHub connection and updates its assignment", async () => {
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/integrations/github", <SettingsGithubPage />);
    await waitForText(container, "Automatic handling");

    const connection = await waitForSelector<HTMLElement>(container, "#connection");
    const taskRouting = await waitForSelector<HTMLElement>(container, "#task-routing");
    expect(connection.compareDocumentPosition(taskRouting) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(taskRouting.textContent).toContain(
      "Choose an Agent to handle Issue and pull request activity from connected GitHub repositories.",
    );
    expect(taskRouting.textContent).toContain("GitHub Task Agent");
    expect(taskRouting.textContent).toContain(
      "automatically handles Issue and pull request activity outside the Context Tree repository and posts final replies as the First Tree GitHub App",
    );
    expect(taskRouting.textContent).toContain(
      "Context Tree activity uses Context Reviewer. These roles must use different Agents.",
    );

    const controls = await waitForSelector<HTMLElement>(taskRouting, '[data-github-task-agent-controls="admin"]');
    expect(controls.parentElement?.style.cssText).toContain("border-top");
    expect(controls.style.border).toBe("");
    expect(controls.style.borderRadius).toBe("");
    expect(controls.style.background).toBe("");

    const select = await waitForSelector<HTMLButtonElement>(taskRouting, '[aria-label="GitHub Task Agent"]');
    await act(async () => select.click());
    const option = [...document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((candidate) =>
      candidate.textContent?.includes("Dev Agent One"),
    );
    await act(async () => option?.click());
    await flush();

    expect(teamAgentMocks.putTeamAgentAssignment).toHaveBeenCalledWith("org-1", "dev-agent-1");
    await act(async () => root.unmount());
  });

  it("shows members the configured Agent without exposing assignment controls", async () => {
    authMock.value = {
      role: "member",
      organizationId: "org-1",
      selectOrganization: vi.fn(async () => undefined),
    };
    orgSettingsMocks.getGithubFeaturesSetting.mockResolvedValue({
      teamAgent: {
        agentUuid: "dev-agent-1",
        agent: { uuid: "dev-agent-1", name: "dev-agent", displayName: "Dev Agent One" },
      },
    });
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/integrations/github", <SettingsGithubPage />);
    await waitForText(container, "Dev Agent One automatically handles Issue and pull request activity");
    expect(container.textContent).toContain("posts final replies as the First Tree GitHub App");

    expect(container.querySelector('[aria-label="GitHub Task Agent"]')).toBeNull();
    expect(teamAgentMocks.getTeamAgentCandidates).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("shows a deployment-operator blocker without a misleading recovery link", async () => {
    teamAgentMocks.getTeamAgentCandidates.mockResolvedValue({
      items: [],
      blockers: [{ code: "github_app_slug_missing", resolutionOwner: "operator", actionKind: null }],
    });
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/integrations/github", <SettingsGithubPage />);
    await waitForText(
      container,
      "A deployment operator must configure the GitHub App login before automatic GitHub handling can run.",
    );

    const taskRouting = await waitForSelector<HTMLElement>(container, "#task-routing");
    expect(taskRouting.textContent).not.toContain("Review connection");
    expect(taskRouting.textContent).not.toContain("Manage Team Agents");
    await act(async () => root.unmount());
  });

  it("links an App permission blocker back to the connection section", async () => {
    teamAgentMocks.getTeamAgentCandidates.mockResolvedValue({
      items: [],
      blockers: [
        {
          code: "github_app_task_reply_permission_required",
          resolutionOwner: "admin",
          actionKind: "manage_github_installation",
        },
      ],
    });
    const { SettingsGithubPage } = await import("../github.js");
    const { container, root } = await renderAt("/settings/integrations/github", <SettingsGithubPage />);
    await waitForText(
      container,
      "The GitHub App installation must grant Issues and Pull requests write access for App-authored task replies.",
    );

    expect(container.querySelector('a[href="/settings/integrations/github#connection"]')?.textContent).toBe(
      "Review connection",
    );
    await act(async () => root.unmount());
  });
});
