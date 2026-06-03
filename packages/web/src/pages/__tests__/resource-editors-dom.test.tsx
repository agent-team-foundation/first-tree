// @vitest-environment happy-dom

import type { ResourceRow } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const authMock = vi.hoisted(() => ({
  value: { role: "admin" as "admin" | "member", organizationId: "org-1" as string | null, meLoaded: true },
}));

const resourceMocks = vi.hoisted(() => ({
  listTeamResources: vi.fn(),
  createTeamResource: vi.fn(),
  updateResource: vi.fn(),
  retireResource: vi.fn(),
  previewOrgResourceImpact: vi.fn(),
}));

vi.mock("../../auth/auth-context.js", () => ({ useAuth: () => authMock.value }));
vi.mock("../../api/resources.js", () => resourceMocks);

const NOW = "2026-06-03T00:00:00.000Z";

function row(over: Partial<ResourceRow> & Pick<ResourceRow, "id" | "type" | "name" | "payload">): ResourceRow {
  return {
    organizationId: "org-1",
    scope: "team",
    ownerAgentId: null,
    repoCanonicalKey: null,
    defaultEnabled: "available",
    status: "active",
    createdBy: "u",
    updatedBy: "u",
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const GITHUB_MCP = row({
  id: "mcp-1",
  type: "mcp",
  name: "github",
  defaultEnabled: "recommended",
  payload: { name: "github", transport: "http", url: "https://mcp.example.com/github" },
});

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false } },
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function render(): Promise<{ root: Root }> {
  const { SettingsResourcesPage } = await import("../settings/resources.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={createClient()}>
        <SettingsResourcesPage />
      </QueryClientProvider>,
    );
  });
  await flush();
  return { root };
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error("click: element not found");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setInputValue(el: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  });
  await flush();
}

function byText(text: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}
function byAria(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);
}

beforeEach(() => {
  document.body.innerHTML = "";
  authMock.value = { role: "admin", organizationId: "org-1", meLoaded: true };
  resourceMocks.listTeamResources.mockResolvedValue([GITHUB_MCP]);
  resourceMocks.createTeamResource.mockResolvedValue(
    row({ id: "new", type: "repo", name: "x", payload: { url: "x" } }),
  );
  resourceMocks.updateResource.mockResolvedValue(GITHUB_MCP);
  resourceMocks.retireResource.mockResolvedValue({ affectedAgentCount: 0, promptOverflowAgentCount: 0 });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resource editors", () => {
  it("creates a repo via the type-first add menu", async () => {
    const { root } = await render();
    // Type-first entry: open the Add menu, pick Repo → repo editor opens.
    await click(byText("Add resource"));
    await click(byText("Repo"));

    const name = document.getElementById("repo-name");
    const url = document.getElementById("repo-url");
    expect(name).toBeTruthy();
    expect(url).toBeTruthy();
    if (!(name instanceof HTMLInputElement) || !(url instanceof HTMLInputElement)) throw new Error("inputs");
    await setInputValue(name, "web");
    await setInputValue(url, "git@github.com:acme/web.git");

    await click(byText("Create"));

    expect(resourceMocks.createTeamResource).toHaveBeenCalledTimes(1);
    // Assert on the first arg only — react-query passes its own context as a
    // trailing arg to mutationFn.
    expect(resourceMocks.createTeamResource.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ type: "repo", name: "web", payload: { url: "git@github.com:acme/web.git" } }),
    );
    await act(async () => root.unmount());
  });

  it("opens an existing mcp resource prefilled for edit and saves via updateResource", async () => {
    const { root } = await render();
    await click(byAria("Edit github"));

    // Prefilled from the existing resource.
    const urlInput = [...document.body.querySelectorAll("input")].find((i) => i.value.includes("mcp.example.com"));
    expect(urlInput).toBeTruthy();
    // Edit mode → the primary action is "Save", not "Create".
    expect(byText("Save")).toBeTruthy();
    expect(byText("Create")).toBeUndefined();

    await click(byText("Save"));
    expect(resourceMocks.updateResource).toHaveBeenCalledTimes(1);
    expect(resourceMocks.updateResource.mock.calls[0]?.[0]).toBe("mcp-1");
    expect(resourceMocks.createTeamResource).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("hides add / edit / retire affordances for members", async () => {
    authMock.value = { role: "member", organizationId: "org-1", meLoaded: true };
    const { root } = await render();
    expect(byText("Add resource")).toBeUndefined();
    expect(byAria("Edit github")).toBeUndefined();
    expect(byAria("Retire github")).toBeUndefined();
    await act(async () => root.unmount());
  });
});
