// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

async function renderDom(element: ReactElement): Promise<{ container: HTMLElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  await flush();
  return { container, root };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function input(el: HTMLInputElement | null, value: string): Promise<void> {
  if (!el) throw new Error("Expected input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("agent lifecycle confirmation dialogs", () => {
  it("explains suspend impact and waits for explicit confirmation", async () => {
    const { AgentSuspendConfirmDialog } = await import("../agent-lifecycle-confirm-dialog.js");
    const onConfirm = vi.fn();
    const { root } = await renderDom(
      <AgentSuspendConfirmDialog
        open
        label="Build Agent"
        pending={false}
        onOpenChange={() => {}}
        onConfirm={onConfirm}
      />,
    );

    expect(document.body.textContent).toContain('Suspend "Build Agent"?');
    expect(document.body.textContent).toContain("runtime will be stopped and unbound");
    expect(document.body.textContent).toContain("New messages and mentions will not wake it");
    expect(document.body.textContent).toContain(
      "Existing configuration, workspace, chat history, and saved sessions are kept",
    );
    expect(onConfirm).not.toHaveBeenCalled();

    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Suspend agent") ?? null);
    expect(onConfirm).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
  });

  it("requires typed name before delete confirmation", async () => {
    const { AgentDeleteConfirmDialog } = await import("../agent-lifecycle-confirm-dialog.js");
    const onDelete = vi.fn();
    const { root } = await renderDom(
      <AgentDeleteConfirmDialog
        open
        expected="Build Agent"
        deleting={false}
        onOpenChange={() => {}}
        onDelete={onDelete}
      />,
    );

    const deleteButton = [...document.querySelectorAll("button")].find((b) => b.textContent === "Delete agent");
    expect(deleteButton).toBeInstanceOf(HTMLButtonElement);
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);

    await input(document.querySelector("input"), "Build Agent");
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false);
    await click(deleteButton ?? null);
    expect(onDelete).toHaveBeenCalledOnce();

    await act(async () => root.unmount());
  });
});
