// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResourceRowView } from "../resource-row.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactElement): void {
  act(() => root.render(node));
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

describe("ResourceRowView — converged action slots", () => {
  it("renders the toggle as an ARIA switch reflecting checked state and flips it on click", async () => {
    const changes: boolean[] = [];
    render(
      <ResourceRowView
        name="Style guide"
        source="From your team"
        toggle={{ checked: true, ariaLabel: "Enable Style guide", onChange: (v) => changes.push(v) }}
      />,
    );
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement | null;
    expect(sw).toBeTruthy();
    expect(sw?.getAttribute("aria-checked")).toBe("true");
    await click(sw);
    expect(changes).toEqual([false]);
  });

  it("disables the toggle when toggle.disabled is set (can't-load state)", () => {
    render(
      <ResourceRowView
        name="Broken skill"
        source="From your team"
        toggle={{ checked: false, disabled: true, ariaLabel: "Enable Broken skill", onChange: () => {} }}
      />,
    );
    const sw = container.querySelector('[role="switch"]') as HTMLButtonElement | null;
    expect(sw?.disabled).toBe(true);
  });

  it("renders the ⋯ overflow menu and fires the selected action", async () => {
    const removed: string[] = [];
    render(
      <ResourceRowView
        name="My repo"
        source="Added by you"
        menu={{
          ariaLabel: "More actions for My repo",
          actions: [
            { key: "remove", label: "Remove My repo", destructive: true, onSelect: () => removed.push("my-repo") },
          ],
        }}
      />,
    );
    const trigger = container.querySelector('[aria-haspopup="menu"]');
    expect(trigger).toBeTruthy();
    await click(trigger);
    const item = [...container.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent === "Remove My repo");
    await click(item ?? null);
    expect(removed).toEqual(["my-repo"]);
  });

  it("suppresses the ⋯ menu entirely when a row has no secondary actions", () => {
    render(
      <ResourceRowView name="Recommended skill" source="From your team" menu={{ ariaLabel: "More", actions: [] }} />,
    );
    expect(container.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });

  it("renders the status marker as a bordered dense badge (Overridden / Can't load), not a plain dot label", () => {
    render(
      <ResourceRowView name="Style guide" source="From your team" status={{ label: "Overridden", tone: "neutral" }} />,
    );
    const overridden = [...container.querySelectorAll("span")].find((s) => s.textContent === "Overridden");
    expect(overridden?.getAttribute("style")).toContain("border");

    render(<ResourceRowView name="Broken" source="From your team" status={{ label: "Can't load", tone: "error" }} />);
    const cantLoad = [...container.querySelectorAll("span")].find((s) => s.textContent === "Can't load");
    expect(cantLoad?.getAttribute("style")).toContain("border");
  });

  it("marks a dimmed row so the disabled-greyed state is visually distinct", () => {
    render(
      <ResourceRowView
        name="Disabled skill"
        source="From your team"
        dimmed
        toggle={{ checked: false, ariaLabel: "Enable Disabled skill", onChange: () => {} }}
      />,
    );
    expect(container.querySelector('[data-dimmed="true"]')).toBeTruthy();
  });

  it("expands via the row heading (no separate chevron button), keeping the cluster to Switch + ⋯", async () => {
    const toggles: number[] = [];
    render(
      <ResourceRowView
        name="Style guide"
        source="From your team"
        expandLabel="instructions"
        toggle={{ checked: true, ariaLabel: "Enable Style guide", onChange: () => {} }}
        expand={{ canExpand: true, expanded: false, onToggle: () => toggles.push(1), body: <p>Full body</p> }}
      />,
    );
    // The heading itself is the expand trigger; clicking it fires onToggle.
    const heading = container.querySelector('button[aria-label="Expand Style guide"]');
    expect(heading).toBeTruthy();
    await click(heading);
    expect(toggles).toEqual([1]);
    // Only the Switch lives in the right cluster — no extra chevron button.
    const buttons = [...container.querySelectorAll("button")];
    const switches = buttons.filter((b) => b.getAttribute("role") === "switch");
    expect(switches).toHaveLength(1);
    // The expand control is the heading (aria-label), not a duplicate chevron button.
    expect(buttons.filter((b) => b.getAttribute("aria-label") === "Expand Style guide")).toHaveLength(1);
  });

  it("opts Instructions into a two-column mobile row without changing the default presentation", () => {
    const actions = [{ key: "edit", label: "Edit", onSelect: () => {} }];
    render(
      <ResourceRowView
        name="Default resource"
        source="From your team"
        toggle={{ checked: true, ariaLabel: "Enable Default resource", onChange: () => {} }}
        menu={{ ariaLabel: "More actions for Default resource", actions }}
      />,
    );
    const defaultHeader = container.querySelector("[data-resource-row] > div");
    expect(defaultHeader?.className).toContain("flex-col");
    expect(defaultHeader?.className).not.toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(container.querySelector('button[aria-label="More actions for Default resource"]')?.className).not.toContain(
      "min-h-11",
    );
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="More actions for Default resource"]')?.style.width,
    ).toBe(`${28}px`);

    render(
      <ResourceRowView
        name="Custom instructions"
        source="For this agent · Editable here"
        peek="A readable three-line prompt excerpt."
        presentation="instruction"
        toggle={{ checked: true, ariaLabel: "Enable Custom instructions", onChange: () => {} }}
        menu={{ ariaLabel: "More actions for Custom instructions", actions }}
      />,
    );
    const instructionHeader = container.querySelector("[data-resource-row] > div");
    expect(instructionHeader?.className).toContain("grid-cols-[minmax(0,1fr)_auto]");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="More actions for Custom instructions"]')?.style
        .width,
    ).toBe("var(--sp-11)");
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="More actions for Custom instructions"]')?.style
        .height,
    ).toBe("var(--sp-11)");
    expect(container.querySelector('button[aria-label="Enable Custom instructions"]')?.className).toContain("h-11");
    expect(container.querySelector('button[aria-label="Enable Custom instructions"]')?.className).toContain("w-11");
    expect(container.querySelector<HTMLElement>("[data-resource-row] > p")?.dataset.lineClamp).toBe("3");
    expect(container.textContent).toContain("For this agent · Editable here");
  });
});
