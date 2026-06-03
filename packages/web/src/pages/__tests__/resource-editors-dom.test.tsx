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
function input(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`input #${id} not found`);
  return el;
}
async function selectOption(triggerId: string, label: string): Promise<void> {
  await click(document.getElementById(triggerId));
  const opt = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent?.trim() === label);
  await click(opt);
}
function lastByPlaceholder(placeholder: string): HTMLInputElement {
  const els = [...document.body.querySelectorAll(`input[placeholder="${placeholder}"]`)];
  const el = els[els.length - 1];
  if (!(el instanceof HTMLInputElement)) throw new Error(`no input[placeholder=${placeholder}]`);
  return el;
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
    // The edit round-trips the resource's payload unchanged (no transport/name drop).
    expect(resourceMocks.updateResource.mock.calls[0]?.[1]?.payload).toEqual({
      name: "github",
      transport: "http",
      url: "https://mcp.example.com/github",
    });
    expect(resourceMocks.createTeamResource).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("creates a stdio mcp with command + args", async () => {
    const { root } = await render();
    await click(byText("Add resource"));
    await click(byText("MCP"));
    await setInputValue(input("mcp-name"), "github");
    await setInputValue(input("mcp-command"), "npx");
    await click(byText("Add")); // add an args row
    await setInputValue(lastByPlaceholder("--flag"), "-y");
    await click(byText("Create"));

    expect(resourceMocks.createTeamResource.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        type: "mcp",
        payload: { name: "github", transport: "stdio", command: "npx", args: ["-y"] },
      }),
    );
    await act(async () => root.unmount());
  });

  it("creates an http mcp with url and no headers key (no-secret schema)", async () => {
    const { root } = await render();
    await click(byText("Add resource"));
    await click(byText("MCP"));
    await selectOption("mcp-transport", "http");
    await setInputValue(input("mcp-name"), "remote");
    await setInputValue(input("mcp-url"), "https://x.example.com/sse");
    await click(byText("Create"));

    const payload = resourceMocks.createTeamResource.mock.calls[0]?.[0]?.payload;
    expect(payload).toEqual({ name: "remote", transport: "http", url: "https://x.example.com/sse" });
    expect("headers" in payload).toBe(false);
    await act(async () => root.unmount());
  });

  it("creates a skill with body and metadata", async () => {
    const { root } = await render();
    await click(byText("Add resource"));
    await click(byText("Skill"));
    await setInputValue(input("skill-name"), "rel");
    const body = document.getElementById("skill-body");
    if (!(body instanceof HTMLTextAreaElement)) throw new Error("skill-body");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(body, "hello world");
      body.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    await click(byText("Add")); // metadata row
    await setInputValue(lastByPlaceholder("key"), "team");
    await setInputValue(lastByPlaceholder("value"), "core");
    await click(byText("Create"));

    const payload = resourceMocks.createTeamResource.mock.calls[0]?.[0]?.payload;
    expect(payload).toEqual(expect.objectContaining({ name: "rel", body: "hello world", metadata: { team: "core" } }));
    await act(async () => root.unmount());
  });

  it("blocks an invalid mcp server name client-side (no API call)", async () => {
    const { root } = await render();
    await click(byText("Add resource"));
    await click(byText("MCP"));
    await setInputValue(input("mcp-name"), "my server"); // space → invalid server id
    await setInputValue(input("mcp-command"), "npx");
    await click(byText("Create"));

    // Validation blocks the call and surfaces a message; nothing is sent.
    expect(resourceMocks.createTeamResource).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Name must be");
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
