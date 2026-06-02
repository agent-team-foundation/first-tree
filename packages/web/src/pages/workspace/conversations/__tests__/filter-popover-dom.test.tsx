// @vitest-environment happy-dom

import type { ChatEngagementView, ChatSource } from "@first-tree/shared";
import { act, type ReactElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterPopover, originLabel } from "../filter-popover.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderDom(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  await flush();
  return container;
}

async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("Expected element to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await flush();
}

function checkboxByLabel(label: string): HTMLInputElement {
  const labels = [...document.body.querySelectorAll("label")];
  const row = labels.find((el) => el.textContent?.includes(label));
  const input = row?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!input) throw new Error(`Missing checkbox ${label}`);
  return input;
}

function StatefulFilter({
  onOriginChange,
  onEngagementChange,
  onResetAll,
}: {
  onOriginChange: (origin: ReadonlyArray<ChatSource>) => void;
  onEngagementChange: (engagement: ChatEngagementView) => void;
  onResetAll: () => void;
}) {
  const [origin, setOrigin] = useState<ChatSource[]>(["github"]);
  const [engagement, setEngagement] = useState<ChatEngagementView>("archived");
  return (
    <FilterPopover
      origin={origin}
      onOriginChange={(next) => {
        setOrigin([...next]);
        onOriginChange(next);
      }}
      engagement={engagement}
      onEngagementChange={(next) => {
        setEngagement(next);
        onEngagementChange(next);
      }}
      onResetAll={() => {
        setOrigin([]);
        setEngagement("active");
        onResetAll();
      }}
      activeCount={origin.length + (engagement !== "active" ? 1 : 0)}
    />
  );
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  root = null;
  document.body.innerHTML = "";
});

describe("FilterPopover", () => {
  it("labels unknown origins defensively", () => {
    expect(originLabel("github")).toBe("GitHub");
    expect(originLabel("future" as ChatSource)).toBe("future");
  });

  it("toggles status, source, reset, reset-all, and done states", async () => {
    const onOriginChange = vi.fn();
    const onEngagementChange = vi.fn();
    const onResetAll = vi.fn();
    const container = await renderDom(
      <StatefulFilter
        onOriginChange={onOriginChange}
        onEngagementChange={onEngagementChange}
        onResetAll={onResetAll}
      />,
    );

    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Filter"]');
    expect(trigger?.textContent).toContain("2");
    await click(trigger ?? null);

    expect(document.body.textContent).toContain("Status");
    expect(document.body.textContent).toContain("Source");
    expect(checkboxByLabel("Active").checked).toBe(false);
    expect(checkboxByLabel("Archived").checked).toBe(true);
    expect(checkboxByLabel("GitHub").checked).toBe(true);
    expect(checkboxByLabel("Manual").checked).toBe(false);

    await click(checkboxByLabel("Manual"));
    expect(onOriginChange).toHaveBeenLastCalledWith(["manual", "github"]);
    expect(trigger?.textContent).toContain("3");

    await click(checkboxByLabel("GitHub"));
    expect(onOriginChange).toHaveBeenLastCalledWith(["manual"]);
    expect(checkboxByLabel("GitHub").checked).toBe(false);

    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Reset") ?? null);
    expect(onOriginChange).toHaveBeenLastCalledWith([]);
    expect(checkboxByLabel("Manual").checked).toBe(false);

    await click(checkboxByLabel("Active"));
    expect(onEngagementChange).toHaveBeenLastCalledWith("all");

    await click(
      [...document.body.querySelectorAll("button")].find((button) => button.textContent === "Reset all") ?? null,
    );
    expect(onResetAll).toHaveBeenCalledTimes(1);

    await click([...document.body.querySelectorAll("button")].find((button) => button.textContent === "Done") ?? null);
    expect(document.body.textContent).not.toContain("Source");
  });
});
