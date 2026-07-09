// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoverCard, type HoverCardPlacement } from "../ui/hover-card.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function pointerEvent(type: string, pointerType = "mouse"): Event {
  if (typeof PointerEvent === "function") {
    return new PointerEvent(type, { bubbles: true, cancelable: true, pointerType });
  }
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { configurable: true, value: pointerType });
  return event;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

async function keyDown(element: Element | null, key: string): Promise<void> {
  if (!element) throw new Error("Expected element for keyDown");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  await flush();
}

function renderHoverCard(placement: HoverCardPlacement = "bottom"): {
  container: HTMLElement;
  root: Root;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ui: ReactElement = (
    <MemoryRouter initialEntries={["/one"]}>
      <HoverCard
        ariaLabel="Agent details"
        placement={placement}
        content={({ close }) => (
          <div>
            <button type="button" onClick={close}>
              Close card
            </button>
            <a href="/agent">Agent link</a>
          </div>
        )}
      >
        Agent trigger
      </HoverCard>
    </MemoryRouter>
  );
  act(() => {
    root.render(ui);
  });
  return { container, root };
}

function dialog(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('[role="dialog"]');
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.body.querySelectorAll("button")).find((button) => button.textContent?.includes(text)) ?? null
  );
}

describe("HoverCard", () => {
  let roots: Root[] = [];
  let originalOffsetWidth: PropertyDescriptor | undefined;
  let originalOffsetHeight: PropertyDescriptor | undefined;
  let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = "";
    roots = [];
    originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    originalRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return this.getAttribute("role") === "dialog" ? 160 : 80;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return this.getAttribute("role") === "dialog" ? 120 : 24;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.tagName === "BUTTON") {
        return {
          bottom: 76,
          height: 24,
          left: 72,
          right: 152,
          top: 52,
          width: 80,
          x: 72,
          y: 52,
          toJSON: () => ({}),
        };
      }
      return originalRect.call(this);
    };
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 240 });
  });

  afterEach(() => {
    for (const root of roots) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
    if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
    if (originalOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", originalOffsetHeight);
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    vi.useRealTimers();
  });

  function mount(placement?: HoverCardPlacement): HTMLElement {
    const rendered = renderHoverCard(placement);
    roots.push(rendered.root);
    return rendered.container;
  }

  it("opens pinned on click and closes from content or outside pointer", async () => {
    const container = mount("right");
    const trigger = container.querySelector("button");

    await click(trigger);
    expect(dialog()?.style.visibility).toBe("visible");
    expect(trigger?.getAttribute("aria-expanded")).toBe("true");

    await click(buttonByText("Close card"));
    expect(dialog()).toBeNull();

    await click(trigger);
    expect(dialog()).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(pointerEvent("pointerdown"));
    });
    await flush();
    expect(dialog()).toBeNull();
  });

  it("opens after hover intent and respects close grace while crossing into the card", async () => {
    const container = mount("left");
    const trigger = container.querySelector("button");

    await act(async () => {
      trigger?.dispatchEvent(pointerEvent("pointerover"));
      vi.advanceTimersByTime(399);
    });
    expect(dialog()).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    await flush();
    expect(dialog()).not.toBeNull();

    await act(async () => {
      trigger?.dispatchEvent(pointerEvent("pointerout"));
      vi.advanceTimersByTime(100);
      dialog()?.dispatchEvent(pointerEvent("pointerover"));
      vi.advanceTimersByTime(100);
    });
    await flush();
    expect(dialog()).not.toBeNull();

    await act(async () => {
      dialog()?.dispatchEvent(pointerEvent("pointerout"));
      vi.advanceTimersByTime(150);
    });
    await flush();
    expect(dialog()).toBeNull();
  });

  it("opens from keyboard, restores focus on Escape, and closes on window scroll", async () => {
    const container = mount("bottom");
    const trigger = container.querySelector("button");
    trigger?.focus();

    await keyDown(trigger, "Enter");
    expect(dialog()).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Close card");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    await flush();
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await click(trigger);
    expect(dialog()).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("scroll", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(dialog()).toBeNull();
  });
});
