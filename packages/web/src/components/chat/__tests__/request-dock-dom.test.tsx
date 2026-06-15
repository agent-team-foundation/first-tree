// @vitest-environment happy-dom

import type { OpenQuestionRequest } from "@first-tree/shared";
import { act, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestDock } from "../request-dock.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function payload(prompt: string): OpenQuestionRequest {
  return {
    subject: "Rollout",
    questions: [{ id: "q1", prompt, kind: "single", options: ["yes", "hold"], required: true }],
    allowExtra: false,
  };
}

const roots: Root[] = [];
async function renderDom(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
  return container;
}

afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

function dock(
  p: OpenQuestionRequest,
  onJumpToOrigin?: () => void,
  overrides?: Partial<ComponentProps<typeof RequestDock>>,
): ReactElement {
  return (
    <RequestDock
      requestId="req"
      payload={p}
      selections={overrides?.selections ?? {}}
      directResolve={overrides?.directResolve ?? false}
      draftEmpty={overrides?.draftEmpty ?? true}
      askerName="asker"
      onPick={() => undefined}
      onJumpToOrigin={onJumpToOrigin}
    />
  );
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(label));
}

describe("RequestDock prompt rendering", () => {
  it("renders the prompt as markdown — no literal ### / ** markers", async () => {
    const container = await renderDom(dock(payload("### Decision needed\n\n**Ship** to 20%?")));
    expect(container.querySelector("h3")?.textContent).toBe("Decision needed");
    expect(container.querySelector("strong")?.textContent).toBe("Ship");
    expect(container.textContent).not.toContain("###");
    expect(container.textContent).not.toContain("**");
  });

  it("keeps a short prompt unclamped — no expand affordance", async () => {
    const container = await renderDom(dock(payload("Ship to 20%?")));
    expect(findButton(container, "Show all")).toBeUndefined();
  });

  it("clamps a legacy wall-of-text prompt and expands on demand", async () => {
    const wall = `## Meeting notes\n${"context line that goes on and on. ".repeat(20)}\n\nAnswer ① or ②?`;
    const container = await renderDom(dock(payload(wall)));
    const showAll = findButton(container, "Show all");
    expect(showAll).toBeDefined();
    expect(showAll?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      showAll?.click();
    });
    const showLess = findButton(container, "Show less");
    expect(showLess).toBeDefined();
    expect(showLess?.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers the way back to the request's timeline card when wired", async () => {
    const jump = vi.fn();
    const container = await renderDom(dock(payload("Ship to 20%?"), jump));
    const view = findButton(container, "View context");
    expect(view).toBeDefined();
    expect(view?.className).toContain("focus-visible:ring-1");
    await act(async () => {
      view?.click();
    });
    expect(jump).toHaveBeenCalledTimes(1);
    // Without the wiring (e.g. preview page) the affordance is hidden.
    const bare = await renderDom(dock(payload("Ship to 20%?")));
    expect(findButton(bare, "View context")).toBeUndefined();
  });

  it("keeps pre-send helper copy neutral even when the draft will resolve", async () => {
    const container = await renderDom(
      dock(payload("Ship to 20%?"), undefined, {
        selections: { "Ship to 20%?": "yes" },
        directResolve: true,
        draftEmpty: false,
      }),
    );
    const helper = Array.from(container.querySelectorAll("div"))
      .reverse()
      .find((el) => el.textContent?.includes("Send answers and resolves this question"));
    expect(helper).toBeDefined();
    expect(helper?.getAttribute("style")).toContain("color: var(--fg-3)");
  });
});
