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
  it("renders runtime and optional computer labels only when visible", async () => {
    const { ContextBar } = await import("../context-bar.js");
    const hidden = await renderDom(
      <ContextBar runtimeLabel="Claude Code" computerLabel="gandy-macbook" visible={false} />,
    );
    expect(hidden.container.textContent).toBe("");
    await act(async () => hidden.root.unmount());

    const withoutComputer = await renderDom(<ContextBar runtimeLabel="Codex" computerLabel={null} />);
    expect(withoutComputer.container.textContent).toContain("Runs on");
    expect(withoutComputer.container.textContent).toContain("Codex");
    expect(withoutComputer.container.textContent).not.toContain("@");
    await act(async () => withoutComputer.root.unmount());

    const withComputer = await renderDom(<ContextBar runtimeLabel="Claude Code" computerLabel="gandy-macbook" />);
    expect(withComputer.container.textContent).toContain("Claude Code");
    expect(withComputer.container.textContent).toContain("@");
    expect(withComputer.container.textContent).toContain("gandy-macbook");
    await act(async () => withComputer.root.unmount());
  });
});
