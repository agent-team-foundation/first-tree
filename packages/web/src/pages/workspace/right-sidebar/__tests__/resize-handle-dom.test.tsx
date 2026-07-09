// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarResizeHandle } from "../resize-handle.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

async function dispatchMouse(target: EventTarget, type: string, init: MouseEventInit = {}): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
}

async function dispatchKey(target: EventTarget, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key }));
  });
}

function handle(rootNode: ParentNode): HTMLButtonElement {
  const button = rootNode.querySelector<HTMLButtonElement>('button[aria-label="Resize chat details"]');
  if (!button) throw new Error("Missing resize handle");
  return button;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
  root = null;
  container = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
  document.body.style.userSelect = "";
  document.body.style.cursor = "";
});

describe("SidebarResizeHandle", () => {
  it("streams clamped drag widths and commits the settled width on mouseup", async () => {
    const onWidthChange = vi.fn();
    const onCommit = vi.fn();
    document.body.style.userSelect = "text";
    document.body.style.cursor = "default";

    const dom = await render(
      <SidebarResizeHandle
        width={320}
        min={240}
        max={480}
        onWidthChange={onWidthChange}
        onCommit={onCommit}
        onReset={() => undefined}
      />,
    );

    await dispatchMouse(handle(dom), "mousedown", { button: 0, clientX: 100 });
    expect(document.body.style.userSelect).toBe("none");
    expect(document.body.style.cursor).toBe("col-resize");

    await dispatchMouse(window, "mousemove", { clientX: 10 });
    await dispatchMouse(window, "mousemove", { clientX: -100 });
    await dispatchMouse(window, "mouseup");

    expect(onWidthChange).toHaveBeenNthCalledWith(1, 410);
    expect(onWidthChange).toHaveBeenNthCalledWith(2, 480);
    expect(onCommit).toHaveBeenCalledWith(480);
    expect(document.body.style.userSelect).toBe("text");
    expect(document.body.style.cursor).toBe("default");
  });

  it("ignores non-primary mouse buttons", async () => {
    const onWidthChange = vi.fn();
    const onCommit = vi.fn();
    const dom = await render(
      <SidebarResizeHandle
        width={320}
        min={240}
        max={480}
        onWidthChange={onWidthChange}
        onCommit={onCommit}
        onReset={() => undefined}
      />,
    );

    await dispatchMouse(handle(dom), "mousedown", { button: 1, clientX: 100 });
    await dispatchMouse(window, "mousemove", { clientX: 0 });
    await dispatchMouse(window, "mouseup");

    expect(onWidthChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(document.body.style.cursor).toBe("");
  });

  it("nudges width from the keyboard and ignores unrelated keys", async () => {
    const onCommit = vi.fn();
    const onWidthChange = vi.fn((next: number) => {
      void next;
    });

    function StatefulHandle() {
      const [width, setWidth] = useState(320);
      return (
        <SidebarResizeHandle
          width={width}
          min={300}
          max={336}
          onWidthChange={(next) => {
            onWidthChange(next);
            setWidth(next);
          }}
          onCommit={onCommit}
          onReset={() => undefined}
        />
      );
    }

    const dom = await render(<StatefulHandle />);
    const resizeHandle = handle(dom);

    await dispatchKey(resizeHandle, "ArrowLeft");
    await dispatchKey(resizeHandle, "ArrowLeft");
    await dispatchKey(resizeHandle, "ArrowRight");
    await dispatchKey(resizeHandle, "Enter");

    expect(onWidthChange.mock.calls).toEqual([[336], [336], [320]]);
    expect(onCommit.mock.calls).toEqual([[336], [336], [320]]);
  });

  it("delegates double-click reset to the parent", async () => {
    const onReset = vi.fn();
    const dom = await render(
      <SidebarResizeHandle
        width={320}
        min={240}
        max={480}
        onWidthChange={() => undefined}
        onCommit={() => undefined}
        onReset={onReset}
      />,
    );

    await dispatchMouse(handle(dom), "dblclick");

    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
