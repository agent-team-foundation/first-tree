// @vitest-environment happy-dom

import type { GithubAppConnectPanelInstallation, GithubAppInstallationOutput } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const githubMocks = vi.hoisted(() => ({
  getGithubAppInstallation: vi.fn(),
  getGithubAppInstallUrl: vi.fn(),
  getGithubAppConnectPanel: vi.fn(),
  connectGithubAppInstallation: vi.fn(),
  disconnectGithubAppInstallation: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    organizationId: "org-1" as string | null,
  },
}));

vi.mock("../../api/github-app.js", () => githubMocks);

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function installation(overrides: Partial<GithubAppInstallationOutput> = {}): GithubAppInstallationOutput {
  return {
    installationId: overrides.installationId ?? 123,
    accountType: overrides.accountType ?? "Organization",
    accountLogin: overrides.accountLogin ?? "acme",
    accountGithubId: overrides.accountGithubId ?? 456,
    permissions: overrides.permissions ?? { contents: "read", issues: "write" },
    events: overrides.events ?? ["issues", "pull_request"],
    suspended: overrides.suspended ?? false,
    manageUrl: overrides.manageUrl ?? "https://github.com/organizations/acme/settings/installations/123",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
}

function panelInstallation(
  overrides: Partial<GithubAppConnectPanelInstallation> = {},
): GithubAppConnectPanelInstallation {
  return {
    installationId: overrides.installationId ?? 321,
    accountType: overrides.accountType ?? "Organization",
    accountLogin: overrides.accountLogin ?? "acme-labs",
    accountGithubId: overrides.accountGithubId ?? 654,
    suspended: overrides.suspended ?? false,
    status: overrides.status ?? "connectable",
    connectedTeamName: overrides.connectedTeamName ?? null,
    createdAt: overrides.createdAt ?? NOW,
  };
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={createClient()}>{element}</QueryClientProvider>);
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
  throw new Error(`Expected text "${text}"`);
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  // The panel persists a per-tab install-attempt marker in sessionStorage; clear
  // it so one test's in-flight attempt doesn't lock the CTA in the next.
  window.sessionStorage.clear();
  authMock.value = { organizationId: "org-1" };
  githubMocks.getGithubAppInstallation.mockResolvedValue(installation());
  githubMocks.getGithubAppInstallUrl.mockResolvedValue("https://github.com/apps/first-tree/installations/new");
  githubMocks.getGithubAppConnectPanel.mockResolvedValue({ installations: [] });
  githubMocks.connectGithubAppInstallation.mockResolvedValue(undefined);
  githubMocks.disconnectGithubAppInstallation.mockResolvedValue(undefined);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { assign: vi.fn() },
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("GithubAppInstallationPanel", () => {
  it("renders bound installation; connection details collapsed until expanded", async () => {
    githubMocks.getGithubAppInstallation.mockResolvedValueOnce(
      installation({ accountType: "User", accountLogin: "octocat", suspended: true }),
    );
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { container, root } = await renderDom(<GithubAppInstallationPanel />);

    await waitForText(container, "Connected to");
    // GitHub accounts render as the full github.com path so a GitHub org is
    // never confusable with a First Tree team name.
    expect(container.textContent).toContain("github.com/octocat");
    expect(container.textContent).toContain("User");
    expect(container.textContent).toContain("suspended upstream");
    expect(container.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      "https://github.com/organizations/acme/settings/installations/123",
    );
    // The connect panel is one click away behind "Manage connection".
    expect(buttonByText(container, "Manage connection")).not.toBeNull();

    // The developer-facing metadata (scopes, events, installation id) lives
    // behind a collapsed "Connection details" disclosure — not mounted until
    // the admin opens it.
    const detailsToggle = buttonByText(container, "Connection details");
    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).not.toContain("contents:");
    expect(container.textContent).not.toContain(`Installation ${"#"}123`);

    await click(detailsToggle);

    expect(detailsToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.textContent).toContain("contents:");
    expect(container.textContent).toContain("issues:");
    expect(container.textContent).toContain("pull_request");
    expect(container.textContent).toContain(`Installation ${"#"}123`);

    await act(async () => root.unmount());
  });

  it("unbound summary shows a prominent Connect GitHub entry into the panel", async () => {
    githubMocks.getGithubAppInstallation.mockResolvedValue(null);
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { container, root } = await renderDom(<GithubAppInstallationPanel />);

    await waitForText(container, "isn't connected to GitHub yet");
    await click(buttonByText(container, "Connect GitHub"));
    await waitForText(container, "Install on GitHub");

    await act(async () => root.unmount());
  });

  it("renders the summary read-only for members", async () => {
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const bound = await renderDom(<GithubAppInstallationPanel readOnly />);

    await waitForText(bound.container, "Connected to");
    expect(bound.container.textContent).toContain("github.com/acme");
    expect(buttonByText(bound.container, "Manage connection")).toBeNull();
    expect([...bound.container.querySelectorAll("a")].some((a) => a.textContent?.includes("Manage on GitHub"))).toBe(
      false,
    );
    await act(async () => bound.root.unmount());

    githubMocks.getGithubAppInstallation.mockResolvedValue(null);
    const unbound = await renderDom(<GithubAppInstallationPanel readOnly />);
    await waitForText(unbound.container, "isn't connected to GitHub yet");
    expect(buttonByText(unbound.container, "Connect GitHub")).toBeNull();
    await act(async () => unbound.root.unmount());
  });

  it("mints a fresh install URL into a new tab, then waits without leaving this tab", async () => {
    githubMocks.getGithubAppInstallation.mockResolvedValue(null);
    const fakeTab = { location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeTab as unknown as Window);
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const first = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(first.container, "Connect GitHub");
    await click(buttonByText(first.container, "Connect GitHub"));
    await waitForText(first.container, "Install on GitHub");

    await click(buttonByText(first.container, "Install on GitHub"));
    // Opens in a new tab (self-closing connected page as post-install target) and
    // navigates THAT tab — this tab stays put and shows the waiting affordance.
    expect(githubMocks.getGithubAppInstallUrl).toHaveBeenCalledWith("org-1", "/onboarding/connected");
    expect(fakeTab.location.href).toBe("https://github.com/apps/first-tree/installations/new");
    expect(window.location.assign).not.toHaveBeenCalled();
    await waitForText(first.container, "Waiting for GitHub");
    // CTA locked while an attempt is in flight (a second mint would clobber the
    // in-flight nonce cookie); "Start over" re-enables it.
    expect(buttonByText(first.container, "Install on GitHub")?.disabled).toBe(true);
    await click(buttonByText(first.container, "Start over"));
    expect(buttonByText(first.container, "Install on GitHub")?.disabled).toBe(false);

    openSpy.mockRestore();
    await act(async () => first.root.unmount());
  });

  it("falls back to a full-page redirect when the install popup is blocked", async () => {
    githubMocks.getGithubAppInstallation.mockResolvedValue(null);
    // Popup blocked → window.open returns null → full-page redirect. `next` is
    // omitted so the server applies its `/settings/github` default (returning
    // this tab to the panel after install).
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { container, root } = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(container, "Connect GitHub");
    await click(buttonByText(container, "Connect GitHub"));
    await waitForText(container, "Install on GitHub");

    await click(buttonByText(container, "Install on GitHub"));
    expect(githubMocks.getGithubAppInstallUrl).toHaveBeenCalledWith("org-1", undefined);
    expect(window.location.assign).toHaveBeenCalledWith("https://github.com/apps/first-tree/installations/new");

    openSpy.mockRestore();
    await act(async () => root.unmount());
  });

  it("surfaces missing slug and reports generic install URL errors (closing the opened tab)", async () => {
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");

    githubMocks.getGithubAppInstallation.mockResolvedValue(null);
    githubMocks.getGithubAppInstallUrl.mockRejectedValueOnce(new ApiError(503, "slug missing"));
    const slugTab = { location: { href: "" }, close: vi.fn() };
    const slugOpen = vi.spyOn(window, "open").mockReturnValue(slugTab as unknown as Window);
    const missingSlug = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(missingSlug.container, "Connect GitHub");
    await click(buttonByText(missingSlug.container, "Connect GitHub"));
    await click(buttonByText(missingSlug.container, "Install on GitHub"));
    await waitForText(missingSlug.container, "FIRST_TREE_GITHUB_APP_SLUG");
    expect(buttonByText(missingSlug.container, "Install on GitHub")).toBeNull();
    // The prematurely-opened tab is closed on failure so no blank tab lingers.
    expect(slugTab.close).toHaveBeenCalled();
    slugOpen.mockRestore();
    await act(async () => missingSlug.root.unmount());

    githubMocks.getGithubAppInstallUrl.mockRejectedValueOnce(new Error("oauth state failed"));
    const genericTab = { location: { href: "" }, close: vi.fn() };
    const genericOpen = vi.spyOn(window, "open").mockReturnValue(genericTab as unknown as Window);
    const generic = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(generic.container, "Connect GitHub");
    await click(buttonByText(generic.container, "Connect GitHub"));
    await click(buttonByText(generic.container, "Install on GitHub"));
    await waitForText(generic.container, "oauth state failed");
    expect(genericTab.close).toHaveBeenCalled();
    genericOpen.mockRestore();
    await act(async () => generic.root.unmount());
  });

  it("lists all panel installations under one Available to connect section and connects a connectable one", async () => {
    githubMocks.getGithubAppInstallation.mockResolvedValue(null);
    githubMocks.getGithubAppConnectPanel.mockResolvedValue({
      installations: [
        panelInstallation({ installationId: 11, accountLogin: "free-org", status: "connectable" }),
        panelInstallation({ installationId: 12, accountLogin: "mine-org", status: "connected-here" }),
        panelInstallation({
          installationId: 13,
          accountLogin: "taken-org",
          status: "connected-elsewhere",
          connectedTeamName: "Other Team",
        }),
      ],
    });
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { container, root } = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(container, "Connect GitHub");
    await click(buttonByText(container, "Connect GitHub"));

    await waitForText(container, "Available to connect");
    // The panel reads as the two steps of the real flow.
    expect(container.textContent).toContain("Step 1: Install the First Tree App on your GitHub");
    expect(container.textContent).toContain("Step 2: Connect to your GitHub");
    expect(container.textContent).toContain("github.com/free-org");
    expect(container.textContent).toContain("Connected to this team");
    expect(container.textContent).toContain("github.com/mine-org");
    expect(container.textContent).not.toContain("Connected to other teams");
    expect(container.textContent).toContain("Connected to Other Team");

    await click(buttonByText(container, "Connect"));
    expect(githubMocks.connectGithubAppInstallation).toHaveBeenCalledWith("org-1", 11);

    await act(async () => root.unmount());
  });

  it("disconnects this team's installation from the panel", async () => {
    githubMocks.getGithubAppConnectPanel.mockResolvedValue({
      installations: [panelInstallation({ installationId: 21, accountLogin: "mine-org", status: "connected-here" })],
    });
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { container, root } = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(container, "Connected to");
    await click(buttonByText(container, "Manage connection"));

    await waitForText(container, "Connected to this team");
    await click(buttonByText(container, "Disconnect"));
    expect(githubMocks.disconnectGithubAppInstallation).toHaveBeenCalledWith("org-1");

    await act(async () => root.unmount());
  });

  it("shows the installed state in Step 1 (Reinstall + Manage on GitHub) once the team is connected", async () => {
    githubMocks.getGithubAppConnectPanel.mockResolvedValue({
      installations: [panelInstallation({ installationId: 22, accountLogin: "mine-org", status: "connected-here" })],
    });
    const fakeTab = { location: { href: "" }, close: vi.fn() };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(fakeTab as unknown as Window);
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { container, root } = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(container, "Connected to");
    await click(buttonByText(container, "Manage connection"));

    // Step 1 flips from the install CTA to the done state with two follow-ups.
    await waitForText(container, "GitHub App installed.");
    expect(buttonByText(container, "Install on GitHub")).toBeNull();
    const manageLink = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Manage on GitHub"));
    expect(manageLink?.href).toBe("https://github.com/organizations/acme/settings/installations/123");

    // Reinstall starts a fresh install through the same mint-on-click flow.
    await click(buttonByText(container, "Reinstall"));
    expect(githubMocks.getGithubAppInstallUrl).toHaveBeenCalledWith("org-1", "/onboarding/connected");
    expect(fakeTab.location.href).toBe("https://github.com/apps/first-tree/installations/new");
    await waitForText(container, "Waiting for GitHub… You may need a GitHub org admin to approve.");

    openSpy.mockRestore();
    await act(async () => root.unmount());
  });

  it("explains a 409 connect conflict in plain words", async () => {
    githubMocks.getGithubAppInstallation.mockResolvedValue(null);
    githubMocks.getGithubAppConnectPanel.mockResolvedValue({
      installations: [panelInstallation({ installationId: 31, accountLogin: "raced-org", status: "connectable" })],
    });
    githubMocks.connectGithubAppInstallation.mockRejectedValueOnce(new ApiError(409, "conflict"));
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const { container, root } = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(container, "Connect GitHub");
    await click(buttonByText(container, "Connect GitHub"));
    await waitForText(container, "Available to connect");

    await click(buttonByText(container, "Connect"));
    await waitForText(container, "already connected to another team");

    await act(async () => root.unmount());
  });

  it("renders disabled, loading, and failed query states", async () => {
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");

    authMock.value = { organizationId: null };
    const disabled = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(disabled.container, "Connect GitHub");
    expect(buttonByText(disabled.container, "Connect GitHub")?.disabled).toBe(true);
    await act(async () => disabled.root.unmount());

    authMock.value = { organizationId: "org-1" };
    githubMocks.getGithubAppInstallation.mockReturnValueOnce(new Promise(() => undefined));
    const loading = await renderDom(<GithubAppInstallationPanel />);
    expect(loading.container.textContent).toContain("Loading");
    await act(async () => loading.root.unmount());

    githubMocks.getGithubAppInstallation.mockRejectedValueOnce(new Error("query failed"));
    const failed = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(failed.container, "query failed");
    await act(async () => failed.root.unmount());
  });
});
