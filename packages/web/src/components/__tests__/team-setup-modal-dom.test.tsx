// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const clientMocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

const authMock = vi.hoisted(() => ({
  value: {
    selectOrganization: vi.fn(),
  },
}));

const routerMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("../../api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client.js")>();
  return { ...actual, api: { ...actual.api, post: clientMocks.post } };
});

vi.mock("../../auth/auth-context.js", () => ({
  useAuth: () => authMock.value,
}));

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useNavigate: () => routerMocks.navigate,
}));

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
    root.render(<MemoryRouter>{element}</MemoryRouter>);
  });
  await flush();
  return { container, root };
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

async function submit(form: HTMLFormElement | null): Promise<void> {
  if (!form) throw new Error("Expected form");
  await act(async () => {
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((button) => button.textContent?.includes(text)) ?? null;
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
  authMock.value.selectOrganization.mockResolvedValue(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("TeamSetupModal", () => {
  it("creates a team with a slugified name, selects it, enters onboarding, and closes", async () => {
    const onClose = vi.fn();
    clientMocks.post.mockResolvedValue({
      organization: { id: "org-new", name: "acme-robotics", displayName: "ACME Robotics!!!", role: "admin" },
    });
    const { TeamSetupModal } = await import("../team-setup-modal.js");
    const { root } = await renderDom(<TeamSetupModal action="create" onClose={onClose} />);

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Team name"]');
    if (!input) throw new Error("Team name input missing");
    expect(buttonByText(document.body, "Create team")?.disabled).toBe(true);
    await setInputValue(input, "  ACME Robotics!!!  ");
    await submit(document.body.querySelector("form"));

    expect(clientMocks.post).toHaveBeenCalledWith("/me/organizations", {
      name: "acme-robotics",
      displayName: "ACME Robotics!!!",
    });
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-new");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routerMocks.navigate).toHaveBeenCalledWith("/onboarding", { replace: true });

    await act(async () => root.unmount());
  });

  it("joins with a token extracted from a full invite URL", async () => {
    const onClose = vi.fn();
    clientMocks.post.mockResolvedValue({ organizationId: "org-joined", memberId: "member-new", role: "member" });
    const { TeamSetupModal } = await import("../team-setup-modal.js");
    const { root } = await renderDom(<TeamSetupModal action="join" onClose={onClose} />);

    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Invite token or full URL"]');
    if (!input) throw new Error("Invite token input missing");
    await setInputValue(input, "https://hub.example/invite/token-123?utm=1");
    await submit(document.body.querySelector("form"));

    expect(clientMocks.post).toHaveBeenCalledWith("/me/organizations/join", { token: "token-123" });
    expect(authMock.value.selectOrganization).toHaveBeenCalledWith("org-joined");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(routerMocks.navigate).toHaveBeenCalledWith("/onboarding", { replace: true });

    await act(async () => root.unmount());
  });

  it("surfaces create and join errors without closing", async () => {
    const { TeamSetupModal } = await import("../team-setup-modal.js");

    clientMocks.post.mockRejectedValueOnce(new Error("create failed"));
    const create = await renderDom(<TeamSetupModal action="create" onClose={vi.fn()} />);
    const createInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Team name"]');
    if (!createInput) throw new Error("Team name input missing");
    await setInputValue(createInput, "Team");
    await submit(document.body.querySelector("form"));
    expect(document.body.textContent).toContain("create failed");
    await act(async () => create.root.unmount());

    clientMocks.post.mockRejectedValueOnce("bad token");
    const join = await renderDom(<TeamSetupModal action="join" onClose={vi.fn()} />);
    const joinInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Invite token or full URL"]');
    if (!joinInput) throw new Error("Invite token input missing");
    await setInputValue(joinInput, "token-1");
    await submit(document.body.querySelector("form"));
    expect(document.body.textContent).toContain("Failed to join team");
    await act(async () => join.root.unmount());
  });
});
