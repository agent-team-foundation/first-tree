// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ContextBar", () => {
  it("renders the agent identity only when visible", async () => {
    const { ContextBar } = await import("../context-bar.js");
    const hidden = await renderDom(
      <ContextBar displayName="Kael" seed="agent-1" runtimeState="idle" visible={false} />,
    );
    expect(hidden.container.textContent).toBe("");
    await act(async () => hidden.root.unmount());

    const shown = await renderDom(<ContextBar displayName="Kael" seed="agent-1" runtimeState="idle" />);
    // Identity (name) is pinned; the old "Runs on <runtime> @ <computer>" strap is gone.
    expect(shown.container.textContent).toContain("Kael");
    expect(shown.container.textContent).not.toContain("Runs on");
    await act(async () => shown.root.unmount());
  });
});
