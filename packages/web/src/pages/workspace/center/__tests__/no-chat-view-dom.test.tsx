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
  return { container, root };
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("NoChatView", () => {
  it("renders the empty chat state and starts a new chat", async () => {
    const onNewChat = vi.fn();
    const { NoChatView } = await import("../no-chat-view.js");
    const { container, root } = await renderDom(<NoChatView onNewChat={onNewChat} />);

    expect(container.textContent).toContain("No chat selected");
    expect(container.textContent).toContain("Start a new chat to put your agent to work");

    await click(
      [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("New chat")) ?? null,
    );
    expect(onNewChat).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
  });

  it("hides the New chat CTA on the trial surface (no escape hatch)", async () => {
    const onNewChat = vi.fn();
    const { NoChatView } = await import("../no-chat-view.js");
    const { container, root } = await renderDom(<NoChatView onNewChat={onNewChat} isTrial />);

    expect(container.textContent).toContain("No chat selected");
    // The create-chat affordance and its copy are gone; a calm pointer replaces them.
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.includes("New chat"))).toBe(false);
    expect(container.textContent).not.toContain("Start a new chat");
    expect(container.textContent).not.toContain("from the list");
    expect(container.textContent).toContain("Set up First Tree");

    await act(async () => root.unmount());
  });
});
