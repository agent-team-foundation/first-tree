// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingRow } from "../setting-row.js";

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

describe("SettingRow", () => {
  it("renders name, effect, right-aligned control, and full-width extras", async () => {
    const { container, root } = await renderDom(
      <SettingRow
        title="GitHub Task Agent"
        description="Dev Agent One handles Issue activity."
        control={<button type="button">Change</button>}
      >
        <span data-testid="extra">Blocker copy</span>
      </SettingRow>,
    );

    expect(container.textContent).toContain("GitHub Task Agent");
    expect(container.textContent).toContain("Dev Agent One handles Issue activity.");
    const control = container.querySelector("button");
    expect(control?.textContent).toBe("Change");
    // The control belongs to the right-hand cluster, not the text column.
    expect(control?.closest("[data-setting-row]")).not.toBeNull();
    expect(control?.parentElement?.className).toContain("sm:justify-end");
    // Extras render below the row line, outside the control cluster.
    const extra = container.querySelector('[data-testid="extra"]');
    expect(extra?.closest("[data-setting-row]")).not.toBeNull();
    expect(extra?.parentElement?.contains(control)).toBe(false);

    await act(async () => root.unmount());
  });

  it("hangs extras off the row's text column when it has a glyph", async () => {
    const { container, root } = await renderDom(
      <SettingRow icon={<svg aria-hidden />} title="GitHub App">
        <span data-testid="extra">Connection details</span>
      </SettingRow>,
    );

    // Without this the block resets to the container edge while the title sits
    // indented past the glyph, leaving two competing left edges.
    const extraWrapper = container.querySelector('[data-testid="extra"]')?.parentElement;
    expect(extraWrapper?.style.paddingLeft).toBe("var(--setting-row-indent)");

    await act(async () => root.unmount());
  });

  it("leaves extras flush when there is no glyph to align to", async () => {
    const { container, root } = await renderDom(
      <SettingRow title="Connection">
        <span data-testid="extra">Detail</span>
      </SettingRow>,
    );

    const extraWrapper = container.querySelector('[data-testid="extra"]')?.parentElement;
    expect(extraWrapper?.style.paddingLeft).toBe("");

    await act(async () => root.unmount());
  });

  it("draws no chrome of its own — the enclosing Section owns the rule", async () => {
    const { container, root } = await renderDom(<SettingRow title="Connection" />);

    const row = container.querySelector<HTMLElement>("[data-setting-row]");
    expect(row).not.toBeNull();
    expect(row?.style.border).toBe("");
    expect(row?.style.borderRadius).toBe("");
    expect(row?.style.background).toBe("");

    await act(async () => root.unmount());
  });

  it("spreads call-site hooks onto the row element", async () => {
    const { container, root } = await renderDom(<SettingRow data-github-task-agent-controls="admin" title="Agent" />);

    const row = container.querySelector<HTMLElement>('[data-github-task-agent-controls="admin"]');
    expect(row?.getAttribute("data-setting-row")).toBe("true");

    await act(async () => root.unmount());
  });

  it("omits the description and control slots when not supplied", async () => {
    const { container, root } = await renderDom(<SettingRow title="Connection" />);

    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector(".sm\\:justify-end")).toBeNull();

    await act(async () => root.unmount());
  });
});
