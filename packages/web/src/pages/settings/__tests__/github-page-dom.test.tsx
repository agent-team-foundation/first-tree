// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The GitHub round-trip return is the only logic under test here; stub the
// installation panel so the test stays focused on the `?from=context` return
// affordance. Team code access now belongs to the parent Integrations layout.
const githubAppMocks = vi.hoisted(() => ({ getGithubAppInstallation: vi.fn() }));
const authMock = vi.hoisted(() => ({
  value: { role: "admin" as string | null, organizationId: "org-1" as string | null },
}));

vi.mock("../../../api/github-app.js", () => githubAppMocks);
vi.mock("../../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../github-app-installation-panel.js", () => ({
  GithubAppInstallationPanel: () => <div data-testid="panel-stub">panel</div>,
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

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value = { role: "admin", organizationId: "org-1" };
  githubAppMocks.getGithubAppInstallation.mockResolvedValue(null);
});

afterEach(() => {
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
});
