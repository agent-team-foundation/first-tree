// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SCENARIOS } from "../dev-fixtures.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

async function render(element: React.ReactElement): Promise<HTMLElement> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  return container;
}

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("missing clickable");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = null;
  container = null;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  document.body.innerHTML = "";
});

describe("DemoNavigator", () => {
  it("renders scenario details, selects adjacent scenarios, collapses notes, and exits", async () => {
    const { DemoNavigator } = await import("../demo-navigator.js");
    const onSelect = vi.fn();
    const onExit = vi.fn();
    const active = DEMO_SCENARIOS[1]?.key ?? "ready-both";
    const firstTitle = DEMO_SCENARIOS[0]?.title ?? "";
    const thirdTitle = DEMO_SCENARIOS[2]?.title ?? "";

    const dom = await render(<DemoNavigator activeKey={active} onSelect={onSelect} onExit={onExit} />);
    expect(dom.textContent).toContain("DEMO 2/");
    expect(dom.textContent).toContain("What to check");

    await click(
      [...dom.querySelectorAll("button")].find((button) => button.textContent?.includes("Hide notes")) ?? null,
    );
    expect(dom.textContent).not.toContain("What to check");

    await click(
      [...dom.querySelectorAll("button")].find((button) => button.textContent?.includes(firstTitle.slice(0, 12))) ??
        null,
    );
    expect(onSelect).toHaveBeenCalledWith(DEMO_SCENARIOS[0]?.key);

    await click(
      [...dom.querySelectorAll("button")].find((button) => button.textContent?.includes(thirdTitle.slice(0, 12))) ??
        null,
    );
    expect(onSelect).toHaveBeenCalledWith(DEMO_SCENARIOS[2]?.key);

    const select = dom.querySelector<HTMLSelectElement>('select[aria-label="Scenario"]');
    const fourthScenario = DEMO_SCENARIOS[3];
    if (!select || !fourthScenario) throw new Error("scenario select missing");
    await act(async () => {
      select.value = fourthScenario.key;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith(fourthScenario.key);

    await click([...dom.querySelectorAll("button")].find((button) => button.textContent === "Exit") ?? null);
    expect(onExit).toHaveBeenCalled();
  });

  it("returns null for unknown active keys", async () => {
    const { DemoNavigator } = await import("../demo-navigator.js");
    const dom = await render(<DemoNavigator activeKey="missing" onSelect={() => undefined} onExit={() => undefined} />);
    expect(dom.textContent).toBe("");
  });

  it("syncs ?demo state with URL and browser history", async () => {
    window.history.replaceState({}, "", `/?demo=${DEMO_SCENARIOS[0]?.key ?? "ready-both"}`);
    const { useDemoScenarioParam } = await import("../demo-navigator.js");
    let latest: readonly [string | null, (key: string | null) => void] = [null, () => undefined];
    function Probe() {
      latest = useDemoScenarioParam();
      return <div>{latest[0]}</div>;
    }

    const dom = await render(<Probe />);
    expect(dom.textContent).toBe(DEMO_SCENARIOS[0]?.key);

    const secondScenario = DEMO_SCENARIOS[1];
    if (!secondScenario) throw new Error("second demo scenario missing");
    await act(async () => latest[1](secondScenario.key));
    expect(window.location.search).toContain(`demo=${secondScenario.key}`);
    expect(dom.textContent).toBe(secondScenario.key);

    window.history.pushState({}, "", "/?demo=not-a-scenario");
    await act(async () => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(dom.textContent).toBe("");

    await act(async () => latest[1](null));
    expect(window.location.search).not.toContain("demo=");
  });
});
