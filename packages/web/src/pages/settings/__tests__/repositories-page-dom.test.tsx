// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({ role: "admin" as "admin" | "member" | null }));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ role: authMock.role }),
}));

vi.mock("../../context-tree-settings-panel.js", () => ({
  ContextTreeSettingsPanel: () => (
    <section data-testid="context-tree-panel">
      <h2>Context Tree</h2>
      <div>Context Tree rows</div>
    </section>
  ),
}));

vi.mock("../resource-sections.js", () => ({
  ResourceTypeSections: (props: {
    types: string[];
    titleFor?: (type: "repo") => string;
    descriptionFor?: (type: "repo") => string;
    addLabelFor?: (type: "repo") => string;
    emptyLabelFor?: (type: "repo") => string;
    compactLimit?: number;
  }) => (
    <section
      data-testid="resource-sections"
      data-types={props.types.join(",")}
      data-compact-limit={props.compactLimit}
      data-add-label={props.addLabelFor?.("repo")}
      data-empty-label={props.emptyLabelFor?.("repo")}
    >
      <h2>{props.titleFor?.("repo")}</h2>
      <p>{props.descriptionFor?.("repo")}</p>
    </section>
  ),
}));

let originalScrollIntoView: typeof HTMLElement.prototype.scrollIntoView;
let scrollIntoView: ReturnType<typeof vi.fn>;

async function renderPage(path = "/settings/repositories"): Promise<{ container: HTMLElement; root: Root }> {
  const { SettingsRepositoriesPage } = await import("../repositories.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <SettingsRepositoriesPage />
      </MemoryRouter>,
    );
  });
  return { container, root };
}

beforeEach(() => {
  authMock.role = "admin";
  originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  scrollIntoView = vi.fn();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("SettingsRepositoriesPage", () => {
  it("composes the two repository models with only two visible section headings", async () => {
    const { container, root } = await renderPage();
    const resources = container.querySelector<HTMLElement>('[data-testid="resource-sections"]');

    expect(resources?.dataset.types).toBe("repo");
    expect(resources?.dataset.compactLimit).toBe("3");
    expect(resources?.dataset.addLabel).toBe("Add repository");
    expect(resources?.dataset.emptyLabel).toBe("No code repositories configured yet.");
    expect(resources?.textContent).toContain("Repositories your agents can read and change.");
    expect(resources?.textContent).toContain("Git credentials on each agent computer");

    const headings = [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Code repositories", "Context Tree"]);
    expect(container.querySelector("h1")).toBeNull();
    expect((container.textContent ?? "").indexOf("Code repositories")).toBeLessThan(
      (container.textContent ?? "").indexOf("Context Tree"),
    );
    expect(scrollIntoView).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it.each([
    ["#code-repositories", "Code repositories"],
    ["#context-tree", "Context Tree"],
  ])("positions and focuses %s", async (hash, label) => {
    const { container, root } = await renderPage(`/settings/repositories${hash}`);
    const target = container.querySelector<HTMLElement>(hash);

    expect(target?.tagName).toBe("SECTION");
    expect(target?.getAttribute("aria-label")).toBe(label);
    expect(target?.tabIndex).toBe(-1);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(target);
    await act(async () => root.unmount());
  });

  it("waits for role resolution before rendering either settings model", async () => {
    authMock.role = null;
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("Loading...");
    expect(container.querySelector("h2")).toBeNull();
    await act(async () => root.unmount());
  });
});
