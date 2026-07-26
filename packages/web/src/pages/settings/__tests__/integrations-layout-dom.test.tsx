// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="repository-destination">{`${location.pathname}${location.hash}`}</div>;
}

async function renderLayout(path = "/settings/integrations/github"): Promise<{ container: HTMLElement; root: Root }> {
  const { SettingsIntegrationsLayout } = await import("../integrations.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings/integrations" element={<SettingsIntegrationsLayout />}>
            <Route path="github" element={<div>GitHub connection content</div>} />
            <Route path="gitlab" element={<div>GitLab connection content</div>} />
          </Route>
          <Route path="/settings/repositories" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("SettingsIntegrationsLayout", () => {
  it("keeps Integrations focused on provider connections", async () => {
    const { container, root } = await renderLayout();

    expect(container.querySelector("h2")?.textContent).toBe("Connections");
    expect(container.textContent).toContain("Connect providers for webhooks, identity, and event routing.");
    expect(container.textContent).toContain("GitHub connection content");
    expect(container.textContent).not.toContain("Code repositories");

    const nav = container.querySelector('nav[aria-label="Connection provider"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelector('a[href="/settings/integrations/github"]')?.getAttribute("aria-current")).toBe("page");
    expect(nav?.querySelector('a[href="/settings/integrations/gitlab"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("marks GitLab active without adding repository management to the provider surface", async () => {
    const { container, root } = await renderLayout("/settings/integrations/gitlab");

    expect(container.textContent).toContain("GitLab connection content");
    expect(container.textContent).not.toContain("Code repositories");
    expect(
      container
        .querySelector('nav[aria-label="Connection provider"] a[href="/settings/integrations/gitlab"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");
    await act(async () => root.unmount());
  });

  it("redirects the former code-access fragment to the new Repositories section", async () => {
    const { container, root } = await renderLayout("/settings/integrations/github#code-access");

    expect(container.querySelector('[data-testid="repository-destination"]')?.textContent).toBe(
      "/settings/repositories#code-repositories",
    );
    await act(async () => root.unmount());
  });
});
