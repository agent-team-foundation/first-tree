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
});
