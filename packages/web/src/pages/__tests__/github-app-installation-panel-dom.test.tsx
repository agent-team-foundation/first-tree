// @vitest-environment happy-dom

import type { GithubAppInstallationOutput } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const githubMocks = vi.hoisted(() => ({
  getGithubAppInstallation: vi.fn(),
  getGithubAppInstallUrl: vi.fn(),
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
  authMock.value = { organizationId: "org-1" };
  githubMocks.getGithubAppInstallation.mockResolvedValue(installation());
  githubMocks.getGithubAppInstallUrl.mockResolvedValue("https://github.com/apps/first-tree/installations/new");
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

    await waitForText(container, "Connected as");
    expect(container.textContent).toContain("octocat");
    expect(container.textContent).toContain("User");
    expect(container.textContent).toContain("suspended upstream");
    expect(container.querySelector<HTMLAnchorElement>("a")?.href).toBe(
      "https://github.com/organizations/acme/settings/installations/123",
    );

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

  it("opens a freshly minted install URL, surfaces missing slug, and reports generic install URL errors", async () => {
    githubMocks.getGithubAppInstallation.mockResolvedValueOnce(null);
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");
    const first = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(first.container, "Install the GitHub App");

    await click(buttonByText(first.container, "Install on GitHub"));
    expect(githubMocks.getGithubAppInstallUrl).toHaveBeenCalledWith("org-1");
    expect(window.location.assign).toHaveBeenCalledWith("https://github.com/apps/first-tree/installations/new");
    await act(async () => first.root.unmount());

    githubMocks.getGithubAppInstallation.mockResolvedValueOnce(null);
    githubMocks.getGithubAppInstallUrl.mockRejectedValueOnce(new ApiError(503, "slug missing"));
    const missingSlug = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(missingSlug.container, "Install the GitHub App");
    await click(buttonByText(missingSlug.container, "Install on GitHub"));
    await waitForText(missingSlug.container, "FIRST_TREE_GITHUB_APP_SLUG");
    expect(buttonByText(missingSlug.container, "Install on GitHub")).toBeNull();
    await act(async () => missingSlug.root.unmount());

    githubMocks.getGithubAppInstallation.mockResolvedValueOnce(null);
    githubMocks.getGithubAppInstallUrl.mockRejectedValueOnce(new Error("oauth state failed"));
    const generic = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(generic.container, "Install the GitHub App");
    await click(buttonByText(generic.container, "Install on GitHub"));
    await waitForText(generic.container, "oauth state failed");
    await act(async () => generic.root.unmount());
  });

  it("renders disabled, loading, and failed query states", async () => {
    const { GithubAppInstallationPanel } = await import("../github-app-installation-panel.js");

    authMock.value = { organizationId: null };
    const disabled = await renderDom(<GithubAppInstallationPanel />);
    await waitForText(disabled.container, "Install the GitHub App");
    expect(buttonByText(disabled.container, "Install on GitHub")?.disabled).toBe(true);
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
