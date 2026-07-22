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
    name: overrides.name ?? "nova",
    displayName: overrides.displayName ?? "Nova",
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

async function waitForText(scope: ParentNode, text: string, timeoutMs = 1200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (scope.textContent?.includes(text)) return;
    await flush();
  }
  throw new Error(`Missing text: ${text}`);
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

async function blurInput(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to blur");
  await act(async () => {
    // React's onBlur listens to the bubbling `focusout` event.
    element.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
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
      fillRect: vi.fn(),
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

describe("AppearanceSection (display-only)", () => {
  it("shows avatar summary and routes Edit + avatar to the unified dialog", async () => {
    const { AppearanceSection } = await import("../appearance-section.js");
    const onEdit = vi.fn();

    const withImage = await renderDom(
      <AppearanceSection
        agent={agent({ avatarColorToken: "hue-3", avatarImageUrl: "/avatars/agent-1.png" })}
        onEdit={onEdit}
      />,
    );
    expect(withImage.container.textContent).toContain("Custom image");
    expect(withImage.container.querySelector('img[alt="Nova"]')).toBeTruthy();
    await click(buttonByText(withImage.container, "Edit"));
    await click(withImage.container.querySelector('button[aria-label="Edit avatar"]'));
    expect(onEdit).toHaveBeenCalledTimes(2);
    await act(async () => withImage.root.unmount());
  });

  it("hides the edit affordance when the caller cannot edit, the agent is inactive, or no onEdit is given", async () => {
    const { AppearanceSection } = await import("../appearance-section.js");
    const onEdit = vi.fn();

    const readOnly = await renderDom(<AppearanceSection agent={agent()} canEdit={false} onEdit={onEdit} />);
    expect(buttonByText(readOnly.container, "Edit")).toBeNull();
    await act(async () => readOnly.root.unmount());

    const inactive = await renderDom(
      <AppearanceSection agent={agent({ status: "suspended" })} canEdit onEdit={onEdit} />,
    );
    expect(buttonByText(inactive.container, "Edit")).toBeNull();
    await act(async () => inactive.root.unmount());

    const noHandler = await renderDom(<AppearanceSection agent={agent()} canEdit />);
    expect(buttonByText(noHandler.container, "Edit")).toBeNull();
    await act(async () => noHandler.root.unmount());
  });
});

describe("IdentitySection (display-only)", () => {
  it("renders resolved identity metadata and routes Edit to the unified dialog", async () => {
    const { IdentitySection } = await import("../identity-section.js");
    const onEdit = vi.fn();
    const human = agent({
      uuid: "human-1",
      name: "bestony",
      displayName: "Bestony",
      type: "human",
      visibility: "private",
      delegateMention: "delegate-1",
      metadata: { tree: { role: "Maintainer", domains: ["agent-hub", "first_tree"] } },
    });

    const { container, root } = await renderDom(<IdentitySection agent={human} onEdit={onEdit} />);
    await flush();
    expect(container.textContent).toContain("Manager User");
    expect(container.textContent).toContain("Helper");
    expect(container.textContent).toContain("@helper");
    expect(container.textContent).toContain("Maintainer");
    expect(container.textContent).toContain("Agent hub");
    expect(container.textContent).toContain("First tree");

    await click(buttonByText(container, "Edit"));
    expect(onEdit).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("omits edit controls for read-only or inactive agents", async () => {
    const { IdentitySection } = await import("../identity-section.js");
    const readOnly = await renderDom(<IdentitySection agent={agent()} canEdit={false} onEdit={vi.fn()} />);
    expect(buttonByText(readOnly.container, "Edit")).toBeNull();
    await act(async () => readOnly.root.unmount());

    const inactive = await renderDom(<IdentitySection agent={agent({ status: "deleted" })} onEdit={vi.fn()} />);
    expect(buttonByText(inactive.container, "Edit")).toBeNull();
    await act(async () => inactive.root.unmount());
  });

  it("shows landing trial agents as First Tree managed instead of leaking the service member id", async () => {
    const { IdentitySection } = await import("../identity-section.js");
    const trial = await renderDom(
      <IdentitySection
        agent={agent({
          managerId: "service-member-hidden",
          metadata: {
            landingCampaignTrial: true,
            campaign: "production-scan",
            skillSetId: "production-scan",
            skillSetVersion: "2026.07.02.1",
            repo: { url: "https://github.com/acme/backend", canonicalKey: "github.com/acme/backend" },
          },
        })}
      />,
    );
    await flush();

    expect(trial.container.textContent).toContain("First Tree managed");
    expect(trial.container.textContent).not.toContain("service-member-hidden");
    await act(async () => trial.root.unmount());
  });
});

describe("ProfileEditDialog (merged identity + appearance)", () => {
  it("saves identity + color in one call, uploads/removes image eagerly, and flashes saved", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();

    const { root } = await renderDom(
      <ProfileEditDialog
        agent={agent({ avatarColorToken: "hue-1", avatarImageUrl: "/avatars/agent-1.png" })}
        open
        onOpenChange={onOpenChange}
        onSave={onSave}
        onRefresh={onRefresh}
        onSaved={onSaved}
      />,
    );
    expect(document.body.textContent).toContain("Edit profile");

    // Image is eager — applies on pick/remove, separate from the Save button.
    const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Expected file input");
    await setFileInput(fileInput, new File(["avatar"], "avatar.png", { type: "image/png" }));
    expect(agentApiMocks.uploadAgentAvatar).toHaveBeenCalledWith("agent-1", expect.any(Blob));
    expect(onRefresh).toHaveBeenCalled();
    await click(buttonByText(document.body, "Remove image"));
    expect(agentApiMocks.deleteAgentAvatar).toHaveBeenCalledWith("agent-1");

    // Colour saves instantly on swatch click — there is no Save button.
    await click(document.body.querySelector('button[title="hue-3"]'));
    expect(onSave).toHaveBeenCalledWith({ avatarColorToken: "hue-3" });
    expect(onSaved).toHaveBeenCalled();
    // "Done" just closes — every field already saved on its own commit.
    await click(buttonByText(document.body, "Done"));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    await act(async () => root.unmount());
  });

  it("blocks save on empty name and keeps the dialog open on a save failure (partial failure)", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Identity update failed"));
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();

    const { root } = await renderDom(
      <ProfileEditDialog agent={agent()} open onOpenChange={onOpenChange} onSave={onSave} onSaved={onSaved} />,
    );

    const displayInput = document.body.querySelector<HTMLInputElement>("#profile-display");
    if (!displayInput) throw new Error("Expected display field");
    // Name commits on blur: empty → inline error, no save.
    await setInputValue(displayInput, " ");
    await blurInput(displayInput);
    expect(document.body.textContent).toContain("Display name is required.");
    expect(onSave).not.toHaveBeenCalled();

    // Valid name commits on blur; the (rejected) save surfaces an error and does
    // not flash "saved". Nothing closes the dialog (Done was never clicked).
    await setInputValue(displayInput, "Nova Updated");
    await blurInput(displayInput);
    expect(onSave).toHaveBeenCalledWith({ displayName: "Nova Updated" });
    expect(document.body.textContent).toContain("Identity update failed");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onSaved).not.toHaveBeenCalled();

    await act(async () => root.unmount());
  });

  it("commits a pending name edit when Done is clicked without an explicit blur", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const { root } = await renderDom(
      <ProfileEditDialog agent={agent()} open onOpenChange={onOpenChange} onSave={onSave} onSaved={vi.fn()} />,
    );
    const displayInput = document.body.querySelector<HTMLInputElement>("#profile-display");
    if (!displayInput) throw new Error("Expected display field");
    // Type a new name but do NOT blur — click Done straight away.
    await setInputValue(displayInput, "Nova Done");
    await click(buttonByText(document.body, "Done"));
    // Done commits the pending name before closing, so the edit isn't lost.
    expect(onSave).toHaveBeenCalledWith({ displayName: "Nova Done" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => root.unmount());
  });

  it("serializes field saves — controls and Done disable while a save is in flight", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const onOpenChange = vi.fn();
    const { root } = await renderDom(
      <ProfileEditDialog
        agent={agent({ avatarColorToken: "hue-1" })}
        open
        onOpenChange={onOpenChange}
        onSave={onSave}
        onSaved={vi.fn()}
      />,
    );
    // Pick a color — the save starts and stays pending (unresolved).
    await click(document.body.querySelector('button[title="hue-3"]'));
    expect(onSave).toHaveBeenCalledTimes(1);
    // While pending: other swatches + Done are disabled, and a second click is
    // dropped by the in-flight guard — no overlapping PATCH, no close mid-save.
    expect(document.body.querySelector<HTMLButtonElement>('button[title="hue-2"]')?.disabled).toBe(true);
    expect(buttonByText(document.body, "Done")?.disabled).toBe(true);
    await click(document.body.querySelector('button[title="hue-2"]'));
    expect(onSave).toHaveBeenCalledTimes(1);
    // Resolve the save → controls re-enable.
    await act(async () => {
      resolveSave?.();
    });
    expect(buttonByText(document.body, "Done")?.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it("retries a rejected name save and does not close on Done", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const onSave = vi.fn().mockRejectedValueOnce(new Error("Name update failed")).mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    const { root } = await renderDom(
      <ProfileEditDialog agent={agent()} open onOpenChange={onOpenChange} onSave={onSave} onSaved={vi.fn()} />,
    );
    const displayInput = document.body.querySelector<HTMLInputElement>("#profile-display");
    if (!displayInput) throw new Error("Expected display field");
    await setInputValue(displayInput, "Nova X");
    // First Done: the name PATCH rejects → error shown, dialog NOT closed, and the
    // value is NOT marked saved (the dedupe baseline only advances on success).
    await click(buttonByText(document.body, "Done"));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Name update failed");
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    // Second Done: Done retries the same value (not skipped); it succeeds and closes.
    await click(buttonByText(document.body, "Done"));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave).toHaveBeenLastCalledWith({ displayName: "Nova X" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => root.unmount());
  });

  it("from a focused display-name input, a blur racing the Done click still saves once and closes", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    const { root } = await renderDom(
      <ProfileEditDialog agent={agent()} open onOpenChange={onOpenChange} onSave={onSave} onSaved={vi.fn()} />,
    );
    const displayInput = document.body.querySelector<HTMLInputElement>("#profile-display");
    if (!displayInput) throw new Error("Expected display field");
    displayInput.focus();
    await setInputValue(displayInput, "Nova Focused");
    // Reproduce the real pointer order with the blur-started save still in flight
    // when Done's click lands — dispatched together, no flush between. Done must
    // wait for the save and still close, saving the name exactly once.
    const done = buttonByText(document.body, "Done");
    await act(async () => {
      done?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      displayInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      done?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ displayName: "Nova Focused" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    await act(async () => root.unmount());
  });

  it("offers the pixel-avatar generator only for non-human agents (humans use their GitHub avatar)", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");

    // Non-human agent: pixel avatar is its identity, so the generator shows.
    const nonHuman = await renderDom(
      <ProfileEditDialog agent={agent({ type: "agent" })} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    expect(document.body.textContent).toContain("Pixel avatar");
    expect(buttonByText(document.body, "Generate")).not.toBeNull();
    await act(async () => nonHuman.root.unmount());

    // Human agent: pixel avatars are reserved for non-human agents, so the
    // generator is hidden — humans fall back to their GitHub avatar.
    document.body.innerHTML = "";
    const human = await renderDom(
      <ProfileEditDialog
        agent={agent({ uuid: "human-1", name: "bestony", displayName: "Bestony", type: "human" })}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(document.body.textContent).not.toContain("Pixel avatar");
    expect(buttonByText(document.body, "Generate")).toBeNull();
    // The custom-image upload path stays available to humans.
    expect(buttonByText(document.body, "Upload image")).not.toBeNull();
    await act(async () => human.root.unmount());
  });

  it("generates and applies a baked pixel avatar candidate", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const { root } = await renderDom(
      <ProfileEditDialog
        agent={agent({ type: "agent" })}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    await click(buttonByText(document.body, "Generate"));
    expect(document.body.textContent).toContain("Shuffle");
    expect(document.body.querySelectorAll('button[title="Use this pixel avatar"]')).toHaveLength(5);

    await click(document.body.querySelector('button[aria-label="Use pixel avatar 1"]'));
    expect(agentApiMocks.uploadAgentAvatar).toHaveBeenCalledWith("agent-1", expect.any(Blob));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await waitForText(document.body, "Generate");

    await act(async () => root.unmount());
  });

  it("surfaces pixel avatar encoding errors without uploading", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const toBlob = vi
      .spyOn(HTMLCanvasElement.prototype, "toBlob")
      .mockImplementation((callback: BlobCallback) => callback(null));
    const { root } = await renderDom(
      <ProfileEditDialog agent={agent({ type: "agent" })} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );

    await click(buttonByText(document.body, "Generate"));
    await click(document.body.querySelector('button[aria-label="Use pixel avatar 1"]'));
    await waitForText(document.body, "Failed to encode the pixel avatar to WEBP.");
    expect(agentApiMocks.uploadAgentAvatar).not.toHaveBeenCalled();

    toBlob.mockRestore();
    await act(async () => root.unmount());
  });

  it("surfaces image decode and remove failures", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    class BrokenImage {
      naturalWidth = 480;
      naturalHeight = 320;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        setTimeout(() => this.onerror?.(), 0);
      }
    }
    Object.defineProperty(globalThis, "Image", { configurable: true, value: BrokenImage });

    const decodeFailure = await renderDom(
      <ProfileEditDialog agent={agent()} open onOpenChange={vi.fn()} onSave={vi.fn()} />,
    );
    const fileInput = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("Expected file input");
    await setFileInput(fileInput, new File(["avatar"], "broken.png", { type: "image/png" }));
    await waitForText(document.body, "Unable to decode the selected image.");
    expect(agentApiMocks.uploadAgentAvatar).not.toHaveBeenCalled();
    await act(async () => decodeFailure.root.unmount());

    installBrowserStubs();
    agentApiMocks.deleteAgentAvatar.mockRejectedValueOnce(new Error("Delete failed"));
    const deleteFailure = await renderDom(
      <ProfileEditDialog
        agent={agent({ avatarImageUrl: "/avatars/agent-1.png" })}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    await click(buttonByText(document.body, "Remove image"));
    await waitForText(document.body, "Delete failed");
    expect(agentApiMocks.deleteAgentAvatar).toHaveBeenCalledWith("agent-1");
    await act(async () => deleteFailure.root.unmount());
  });

  it("submits display name through the form and saves the auto color swatch", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { root } = await renderDom(
      <ProfileEditDialog agent={agent({ avatarColorToken: "hue-2" })} open onOpenChange={vi.fn()} onSave={onSave} />,
    );
    const displayInput = document.body.querySelector<HTMLInputElement>("#profile-display");
    const form = document.body.querySelector("form");
    if (!displayInput || !form) throw new Error("Expected profile form");

    await setInputValue(displayInput, "Nova Form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(onSave).toHaveBeenCalledWith({ displayName: "Nova Form" });

    await click(document.body.querySelector('button[title="Auto"]'));
    expect(onSave).toHaveBeenCalledWith({ avatarColorToken: null });

    await act(async () => root.unmount());
  });

  it("renders a resolved read-only delegate chip for other human members", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    authMock.value = { memberId: "member-other", role: "member", agentId: "human-other" };
    const { root } = await renderDom(
      <ProfileEditDialog
        agent={agent({
          uuid: "human-1",
          name: "bestony",
          displayName: "Bestony",
          type: "human",
          delegateMention: "delegate-1",
        })}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />,
    );

    await waitForText(document.body, "Helper");
    expect(document.body.textContent).toContain("@helper");
    expect(document.body.querySelector("#profile-delegate")).toBeNull();
    expect(document.body.textContent).toContain("Only the member themselves can set their own delegate.");

    await act(async () => root.unmount());
  });

  it("edits human visibility + delegate, and disables visibility for non-owners", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    const human = agent({
      uuid: "human-1",
      name: "bestony",
      displayName: "Bestony",
      type: "human",
      visibility: "private",
    });
    const onSave = vi.fn().mockResolvedValue(undefined);

    const owner = await renderDom(
      <ProfileEditDialog agent={human} open onOpenChange={vi.fn()} onSave={onSave} onSaved={vi.fn()} />,
    );
    const disabledName = document.body.querySelector<HTMLInputElement>("input.font-mono");
    expect(disabledName?.value).toBe("@bestony");
    expect(disabledName?.disabled).toBe(true);
    const visibilitySelect = document.body.querySelector<HTMLButtonElement>("#profile-visibility");
    const delegateSelect = document.body.querySelector<HTMLButtonElement>("#profile-delegate");
    if (!visibilitySelect || !delegateSelect) throw new Error("Expected human projection fields");
    expect(document.body.querySelector("#profile-display")).toBeNull();
    expect(document.body.textContent).not.toContain("Display name");
    // Each field saves on its own commit — no Save button.
    await chooseSelectOption(visibilitySelect, "Visible to your team");
    expect(onSave).toHaveBeenCalledWith({ visibility: "organization" });
    await chooseSelectOption(delegateSelect, "Second Helper");
    expect(onSave).toHaveBeenCalledWith({ delegateMention: "delegate-2" });
    await act(async () => owner.root.unmount());

    authMock.value = { memberId: "member-other", role: "member", agentId: "human-other" };
    const nonOwner = await renderDom(
      <ProfileEditDialog
        agent={agent({ managerId: "member-self", visibility: "private" })}
        open
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    const lockedVisibility = document.body.querySelector<HTMLButtonElement>("#profile-visibility");
    expect(lockedVisibility?.disabled).toBe(true);
    expect(document.body.textContent).toContain("Only the owner or an admin can change this agent's visibility.");
    await act(async () => nonOwner.root.unmount());
  });

  it("offers your own private agent as a delegate (visibility no longer filtered)", async () => {
    const { ProfileEditDialog } = await import("../profile-edit-dialog.js");
    // A private agent you own is a valid delegate: the picker no longer filters
    // on visibility, mirroring the server (which accepts a private delegate).
    // Only `managerId === you` + active + type=agent gate the options now.
    agentApiMocks.listAgents.mockResolvedValue({
      items: [
        agent({ uuid: "private-pa", name: "pa", displayName: "Private PA", type: "agent", visibility: "private" }),
      ],
      nextCursor: null,
    });
    const human = agent({
      uuid: "human-1",
      name: "bestony",
      displayName: "Bestony",
      type: "human",
      visibility: "private",
    });
    const onSave = vi.fn().mockResolvedValue(undefined);

    const owner = await renderDom(
      <ProfileEditDialog agent={human} open onOpenChange={vi.fn()} onSave={onSave} onSaved={vi.fn()} />,
    );
    const delegateSelect = document.body.querySelector<HTMLButtonElement>("#profile-delegate");
    if (!delegateSelect) throw new Error("Expected delegate field");
    await chooseSelectOption(delegateSelect, "Private PA");
    expect(onSave).toHaveBeenCalledWith({ delegateMention: "private-pa" });
    await act(async () => owner.root.unmount());
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
