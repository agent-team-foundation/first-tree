// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({ role: "admin" as "admin" | "member" | null }));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => ({ role: authMock.role }),
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
        <Routes>
          <Route path="/settings/repositories" element={<SettingsRepositoriesPage />} />
          <Route path="/settings/setup" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-location={`${location.pathname}${location.hash}`} />;
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
  it("renders only the Team code repository catalog", async () => {
    const { container, root } = await renderPage();
    const resources = container.querySelector<HTMLElement>('[data-testid="resource-sections"]');

    expect(resources?.dataset.types).toBe("repo");
    expect(resources?.dataset.compactLimit).toBe("3");
    expect(resources?.dataset.addLabel).toBe("Add repository");
    expect(resources?.dataset.emptyLabel).toBe("No code repositories configured yet.");
    expect(resources?.textContent).toContain("Repositories your agents can read and change.");
    expect(resources?.textContent).toContain("Git credentials on each agent computer");

    const headings = [...container.querySelectorAll("h2")].map((heading) => heading.textContent);
    expect(headings).toEqual(["Code repositories"]);
    expect(container.querySelector("h1")).toBeNull();
    expect(container.textContent).not.toContain("Context Tree rows");
    expect(container.textContent).not.toContain("Automatic PR review");
    expect(container.textContent).not.toContain("Automatic MR review");
    expect(scrollIntoView).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("positions and focuses the code catalog anchor", async () => {
    const { container, root } = await renderPage("/settings/repositories#code-repositories");
    const target = container.querySelector<HTMLElement>("#code-repositories");

    expect(target?.tagName).toBe("SECTION");
    expect(target?.getAttribute("aria-label")).toBe("Code repositories");
    expect(target?.tabIndex).toBe(-1);
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(target);
    await act(async () => root.unmount());
  });

  it("redirects the retired Context Tree anchor to canonical Setup controls", async () => {
    const { container, root } = await renderPage("/settings/repositories#context-tree");

    expect(container.querySelector("[data-location]")?.getAttribute("data-location")).toBe(
      "/settings/setup#context-tree",
    );
    expect(container.querySelector('[data-testid="resource-sections"]')).toBeNull();
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
