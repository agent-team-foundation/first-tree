// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
let scrollIntoView: ReturnType<typeof vi.fn>;

vi.mock("../resource-sections.js", () => ({
  ResourceTypeSections: (props: {
    types: string[];
    titleFor?: (type: "repo") => string;
    descriptionFor?: (type: "repo") => string;
    addLabelFor?: (type: "repo") => string;
    emptyLabelFor?: (type: "repo") => string;
    compactLimit?: number;
  }) => (
    <div
      data-testid="resource-sections"
      data-types={props.types.join(",")}
      data-compact-limit={props.compactLimit}
      data-add-label={props.addLabelFor?.("repo")}
      data-empty-label={props.emptyLabelFor?.("repo")}
    >
      <span>{props.titleFor?.("repo")}</span>
      <span>{props.descriptionFor?.("repo")}</span>
    </div>
  ),
}));

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
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

beforeEach(() => {
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SettingsIntegrationsLayout", () => {
  it("places provider-neutral Team code access above provider connections", async () => {
    const { container, root } = await renderLayout();
    const resourceSections = container.querySelector<HTMLElement>('[data-testid="resource-sections"]');
    expect(resourceSections?.dataset.types).toBe("repo");
    expect(resourceSections?.dataset.compactLimit).toBe("3");
    expect(resourceSections?.dataset.addLabel).toBe("Add code repository");
    expect(resourceSections?.dataset.emptyLabel).toBe("No code repositories configured yet.");
    expect(resourceSections?.textContent).toContain("Code available to agents");
    expect(resourceSections?.textContent).toContain("GitHub, GitLab, or any Git server");
    expect(resourceSections?.textContent).toContain("Git credentials on each agent's computer");

    const text = container.textContent ?? "";
    expect(text.indexOf("Code available to agents")).toBeLessThan(text.indexOf("Connections"));
    expect(text.indexOf("Connections")).toBeLessThan(text.indexOf("GitHub connection content"));

    const nav = container.querySelector('nav[aria-label="Connection provider"]');
    expect(nav).not.toBeNull();
    expect(nav?.querySelector('a[href="/settings/integrations/github"]')?.getAttribute("aria-current")).toBe("page");
    expect(nav?.querySelector('a[href="/settings/integrations/gitlab"]')).not.toBeNull();
    expect(scrollIntoView).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("keeps the shared code area above the long GitLab connection surface", async () => {
    const { container, root } = await renderLayout("/settings/integrations/gitlab");
    const text = container.textContent ?? "";
    expect(text.indexOf("Code available to agents")).toBeLessThan(text.indexOf("GitLab connection content"));
    expect(
      container
        .querySelector('nav[aria-label="Connection provider"] a[href="/settings/integrations/gitlab"]')
        ?.getAttribute("aria-current"),
    ).toBe("page");
    await act(async () => root.unmount());
  });

  it("positions and focuses the shared code section when the Agent shortcut supplies its hash", async () => {
    const { container, root } = await renderLayout("/settings/integrations/github#code-access");
    const target = container.querySelector<HTMLElement>("#code-access");
    expect(target?.tagName).toBe("SECTION");
    expect(target?.getAttribute("aria-label")).toBe("Code available to agents");
    expect(target?.tabIndex).toBe(-1);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(target);
    await act(async () => root.unmount());
  });
});
