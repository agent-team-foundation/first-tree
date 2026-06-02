// @vitest-environment happy-dom

import type { Agent } from "@first-tree/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const agentApiMocks = vi.hoisted(() => ({
  deleteAgentAvatar: vi.fn(),
  listAgents: vi.fn(),
  listManagedAgents: vi.fn(),
  uploadAgentAvatar: vi.fn(),
}));

const memberApiMocks = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    memberId: "member-self",
    role: "admin",
    agentId: "human-1",
  },
}));

vi.mock("../../../api/agents.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/agents.js")>()),
  deleteAgentAvatar: agentApiMocks.deleteAgentAvatar,
  listAgents: agentApiMocks.listAgents,
  listManagedAgents: agentApiMocks.listManagedAgents,
  uploadAgentAvatar: agentApiMocks.uploadAgentAvatar,
}));

vi.mock("../../../api/members.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../api/members.js")>()),
  listMembers: memberApiMocks.listMembers,
}));

vi.mock("../../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

const NOW = "2026-05-28T12:00:00.000Z";

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    uuid: overrides.uuid ?? "agent-1",
    name: overrides.name ?? "kael",
    displayName: overrides.displayName ?? "Kael",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "member-self",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "org-1",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? "inbox-1",
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? "client-1",
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
  };
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
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  await flush();
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function pointerDown(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to receive pointerdown");
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function keyDownOn(element: Element | null, key: string): Promise<void> {
  if (!element) throw new Error("Expected element to receive keydown");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

async function setInputValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function setFileInput(element: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(element, "files", { configurable: true, value: [file] });
  await act(async () => {
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement | null {
  return [...scope.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

async function chooseSelectOption(trigger: Element | null, optionText: string): Promise<void> {
  await click(trigger);
  await click(buttonByText(document.body, optionText));
}

function installBrowserStubs(): void {
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob://avatar") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({
      drawImage: vi.fn(),
    })),
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toBlob", {
    configurable: true,
    value: vi.fn((callback: BlobCallback) => callback(new Blob(["webp"], { type: "image/webp" }))),
  });
  class TestImage {
    naturalWidth = 480;
    naturalHeight = 320;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;

    set src(_value: string) {
      setTimeout(() => this.onload?.(), 0);
    }
  }
  Object.defineProperty(globalThis, "Image", { configurable: true, value: TestImage });
}

beforeEach(() => {
  document.body.innerHTML = "";
  installBrowserStubs();
  authMock.value = { memberId: "member-self", role: "admin", agentId: "human-1" };
  agentApiMocks.deleteAgentAvatar.mockReset();
  agentApiMocks.listAgents.mockReset();
  agentApiMocks.listManagedAgents.mockReset();
  agentApiMocks.uploadAgentAvatar.mockReset();
  memberApiMocks.listMembers.mockReset();
  agentApiMocks.deleteAgentAvatar.mockResolvedValue(undefined);
  agentApiMocks.uploadAgentAvatar.mockResolvedValue({ avatarImageUrl: "/avatars/agent-1.webp" });
  agentApiMocks.listManagedAgents.mockResolvedValue([]);
  memberApiMocks.listMembers.mockResolvedValue([
    {
      id: "member-self",
      userId: "user-self",
      organizationId: "org-1",
      agentId: "human-1",
      role: "admin",
      createdAt: NOW,
      username: "manager",
      displayName: "Manager User",
    },
  ]);
  agentApiMocks.listAgents.mockResolvedValue({
    items: [
      agent({ uuid: "delegate-1", name: "helper", displayName: "Helper", type: "agent" }),
      agent({ uuid: "delegate-2", name: "second", displayName: "Second Helper", type: "agent" }),
      agent({
        uuid: "public-agent",
        name: "public",
        displayName: "Public Agent",
        type: "agent",
        visibility: "organization",
      }),
    ],
    nextCursor: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AppearanceSection", () => {
  it("edits avatar color, uploads a resized image, removes an image, and reports save errors", async () => {
    const { AppearanceSection } = await import("../appearance-section.js");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    const first = await renderDom(
      <AppearanceSection agent={agent({ avatarColorToken: "hue-1" })} onSave={onSave} onRefresh={onRefresh} />,
    );
    expect(first.container.textContent).toContain("Color hue-1");

    await click(buttonByText(first.container, "Edit"));
    expect(document.body.textContent).toContain("Edit Appearance");
    await click(document.body.querySelector('button[title="hue-3"]'));
    await click(buttonByText(document.body, "Save"));
    expect(onSave).toHaveBeenCalledWith({ avatarColorToken: "hue-3" });

    await act(async () => first.root.unmount());

    const second = await renderDom(
      <AppearanceSection
        agent={agent({ avatarColorToken: "hue-3", avatarImageUrl: "/avatars/agent-1.png" })}
        onSave={onSave}
        onRefresh={onRefresh}
      />,
    );
    expect(second.container.textContent).toContain("Custom image");
    expect(second.container.querySelector('img[alt="Kael"]')).toBeTruthy();

    await click(buttonByText(second.container, "Edit"));
    const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Expected file input");
    await setFileInput(fileInput, new File(["avatar"], "avatar.png", { type: "image/png" }));
    expect(agentApiMocks.uploadAgentAvatar).toHaveBeenCalledWith("agent-1", expect.any(Blob));
    expect(onRefresh).toHaveBeenCalled();

    await click(buttonByText(document.body, "Remove image"));
    expect(agentApiMocks.deleteAgentAvatar).toHaveBeenCalledWith("agent-1");

    onSave.mockRejectedValueOnce(new Error("Color update failed"));
    await click(document.body.querySelector('button[title="Auto"]'));
    await click(buttonByText(document.body, "Save"));
    expect(document.body.textContent).toContain("Color update failed");

    await act(async () => second.root.unmount());
  });

  it("hides edit controls when the caller cannot edit or the agent is inactive", async () => {
    const { AppearanceSection } = await import("../appearance-section.js");
    const onSave = vi.fn();

    const readOnly = await renderDom(<AppearanceSection agent={agent()} canEdit={false} onSave={onSave} />);
    expect(buttonByText(readOnly.container, "Edit")).toBeNull();
    await act(async () => readOnly.root.unmount());

    const inactive = await renderDom(
      <AppearanceSection agent={agent({ status: "suspended" })} canEdit onSave={onSave} />,
    );
    expect(buttonByText(inactive.container, "Edit")).toBeNull();
    await act(async () => inactive.root.unmount());
  });
});

describe("IdentitySection", () => {
  it("renders resolved identity metadata and saves human identity edits", async () => {
    const { IdentitySection } = await import("../identity-section.js");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const human = agent({
      uuid: "human-1",
      name: "bestony",
      displayName: "Bestony",
      type: "human",
      visibility: "private",
      delegateMention: "delegate-1",
      metadata: { tree: { role: "Maintainer", domains: ["agent-hub", "first_tree"] } },
    });

    const { container, root } = await renderDom(<IdentitySection agent={human} onSave={onSave} />);
    await flush();
    expect(container.textContent).toContain("Manager User");
    expect(container.textContent).toContain("Helper");
    expect(container.textContent).toContain("@helper");
    expect(container.textContent).toContain("Maintainer");
    expect(container.textContent).toContain("Agent hub");
    expect(container.textContent).toContain("First tree");

    await click(buttonByText(container, "Edit"));
    const disabledName = document.body.querySelector<HTMLInputElement>("input.font-mono");
    expect(disabledName?.value).toBe("@bestony");
    expect(disabledName?.disabled).toBe(true);

    const displayInput = document.body.querySelector<HTMLInputElement>("#id-display");
    const visibilitySelect = document.body.querySelector<HTMLButtonElement>("#id-visibility");
    const delegateSelect = document.body.querySelector<HTMLButtonElement>("#id-delegate");
    if (!displayInput || !visibilitySelect || !delegateSelect) throw new Error("Expected identity fields");

    await setInputValue(displayInput, " ");
    await click(buttonByText(document.body, "Save"));
    expect(document.body.textContent).toContain("Display name is required.");
    expect(onSave).not.toHaveBeenCalled();

    await setInputValue(displayInput, "Bestony Renamed");
    await chooseSelectOption(visibilitySelect, "Visible to your team");
    await chooseSelectOption(delegateSelect, "Second Helper");
    await click(buttonByText(document.body, "Save"));
    expect(onSave).toHaveBeenCalledWith({
      displayName: "Bestony Renamed",
      delegateMention: "delegate-2",
      visibility: "organization",
    });

    await act(async () => root.unmount());
  });

  it("disables visibility for non-owners and surfaces save errors", async () => {
    const { IdentitySection } = await import("../identity-section.js");
    authMock.value = { memberId: "member-other", role: "member", agentId: "human-other" };
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Identity update failed"));
    const { container, root } = await renderDom(
      <IdentitySection
        agent={agent({ managerId: "member-self", visibility: "private", metadata: { tree: { domains: [""] } } })}
        onSave={onSave}
      />,
    );

    await click(buttonByText(container, "Edit"));
    const visibilitySelect = document.body.querySelector<HTMLButtonElement>("#id-visibility");
    expect(visibilitySelect?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Only the owner or an admin can change this agent's visibility.");

    const displayInput = document.body.querySelector<HTMLInputElement>("#id-display");
    if (!displayInput) throw new Error("Expected display field");
    await setInputValue(displayInput, "Kael Updated");
    await click(buttonByText(document.body, "Save"));
    expect(onSave).toHaveBeenCalledWith({
      displayName: "Kael Updated",
    });
    expect(document.body.textContent).toContain("Identity update failed");

    await act(async () => root.unmount());
  });

  it("omits edit controls for read-only or inactive agents", async () => {
    const { IdentitySection } = await import("../identity-section.js");
    const onSave = vi.fn();
    const readOnly = await renderDom(<IdentitySection agent={agent()} canEdit={false} onSave={onSave} />);
    expect(buttonByText(readOnly.container, "Edit")).toBeNull();
    await act(async () => readOnly.root.unmount());

    const inactive = await renderDom(<IdentitySection agent={agent({ status: "deleted" })} onSave={onSave} />);
    expect(buttonByText(inactive.container, "Edit")).toBeNull();
    await act(async () => inactive.root.unmount());
  });
});

describe("Select", () => {
  it("opens in a portal, selects values, dismisses on outside pointer and Escape, and renders changed state", async () => {
    const { DraftStatusChip } = await import("../../../components/ui/draft-status-chip.js");
    const { Select } = await import("../../../components/ui/select.js");
    const onChange = vi.fn();
    const getRect = vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect");
    getRect.mockReturnValue({
      x: 10,
      y: 20,
      top: 20,
      right: 210,
      bottom: 48,
      left: 10,
      width: 200,
      height: 28,
      toJSON: () => ({}),
    });

    const { container, root } = await renderDom(
      <>
        <Select
          value="alpha"
          onChange={onChange}
          options={[
            { value: "", label: "Unset", hint: "fallback" },
            { value: "alpha", label: "Alpha", hint: "current" },
            { value: "beta", label: "Beta", hint: "new" },
          ]}
        />
        <DraftStatusChip status="modified" />
        <button type="button">Outside</button>
      </>,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("changed");

    await click(trigger);
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Unset");
    expect(document.body.textContent).toContain("fallback");
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("scroll"));
    });
    await flush();

    await click(buttonByText(document.body, "Beta"));
    expect(onChange).toHaveBeenCalledWith("beta");
    expect(document.body.textContent).not.toContain("Unsetfallback");

    await click(trigger);
    await pointerDown(buttonByText(container, "Outside"));
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await click(trigger);
    await keyDownOn(document.body.querySelector('[role="listbox"]'), "Escape");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);

    await act(async () => root.unmount());
    getRect.mockRestore();
  });

  it("stays closed when disabled and falls back to the raw value for unknown selections", async () => {
    const { Select } = await import("../../../components/ui/select.js");
    const onChange = vi.fn();
    const { container, root } = await renderDom(
      <Select value="missing" disabled onChange={onChange} options={[{ value: "alpha", label: "Alpha" }]} />,
    );
    expect(container.textContent).toContain("missing");
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]');
    await click(trigger);
    expect(document.body.querySelector('[style*="z-index"]')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
