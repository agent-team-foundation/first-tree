// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskTakeover } from "../ask-takeover.js";

// The body renders through the app's Markdown; stub it to plain text so this
// test pins the answer surface, not the markdown pipeline.
vi.mock("../../ui/markdown.js", () => ({
  Markdown: ({ children }: { children: string }) => children,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const OPTS = [
  { label: "Ship", description: "ship now", preview: "ft deploy --to 20" },
  { label: "Hold", description: "wait 24h" },
];

const roots: Root[] = [];
async function renderDom(element: ReactElement): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function setValue(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  });
}
function option(c: ParentNode, text: string): HTMLButtonElement | null {
  return (
    [...c.querySelectorAll<HTMLButtonElement>('[role="radio"],[role="checkbox"]')].find((b) =>
      b.textContent?.includes(text),
    ) ?? null
  );
}
function btn(c: ParentNode, text: string): HTMLButtonElement | null {
  return [...c.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) ?? null;
}

describe("AskTakeover", () => {
  it("single-select: Reply gated on a pick, preview shows only when selected, sends the label", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover
        body="# Ship?"
        payload={{ multiSelect: false, options: OPTS }}
        onReply={onReply}
        onSkip={() => {}}
      />,
    );
    expect(btn(c, "Reply")?.disabled).toBe(true);
    // preview hidden before selection
    expect(c.textContent).not.toContain("ft deploy --to 20");

    await click(option(c, "Ship"));
    expect(c.textContent).toContain("ft deploy --to 20"); // preview now visible
    expect(btn(c, "Reply")?.disabled).toBe(false);
    expect(option(c, "Ship")?.getAttribute("aria-checked")).toBe("true");

    // single: selecting Hold replaces Ship
    await click(option(c, "Hold"));
    expect(option(c, "Ship")?.getAttribute("aria-checked")).toBe("false");
    expect(option(c, "Hold")?.getAttribute("aria-checked")).toBe("true");

    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith("Hold");
  });

  it("multi-select: toggles several options; Reply joins the labels", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Pick" payload={{ multiSelect: true, options: OPTS }} onReply={onReply} onSkip={() => {}} />,
    );
    await click(option(c, "Ship"));
    await click(option(c, "Hold"));
    expect(option(c, "Ship")?.getAttribute("aria-checked")).toBe("true");
    expect(option(c, "Hold")?.getAttribute("aria-checked")).toBe("true");
    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith("Ship, Hold");
  });

  it("options + Other free text merge into the answer", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Pick" payload={{ multiSelect: false, options: OPTS }} onReply={onReply} onSkip={() => {}} />,
    );
    await click(option(c, "Ship"));
    const other = c.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Other"]');
    if (!other) throw new Error("Other input missing");
    await setValue(other, "but watch the canary");
    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith("Ship\nbut watch the canary");
  });

  it("free-text ask (no options): Reply gated on text, sends the typed answer", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={onReply} onSkip={() => {}} />,
    );
    expect(btn(c, "Reply")?.disabled).toBe(true);
    const ta = c.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "looks risky");
    expect(btn(c, "Reply")?.disabled).toBe(false);
    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith("looks risky");
  });

  it("body + options scroll together while the Skip/Reply footer stays pinned", async () => {
    // A very long ask body — far taller than a viewport.
    const longBody = Array.from({ length: 200 }, (_, i) => `Paragraph line ${i} of the ask body.`).join("\n\n");
    const c = await renderDom(
      <AskTakeover
        body={longBody}
        payload={{ multiSelect: false, options: OPTS }}
        onReply={() => {}}
        onSkip={() => {}}
      />,
    );

    const dialog = c.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error("dialog missing");
    // The card is a two-region column: [0] = the scrolling region (ask body +
    // answer surface), [1] = the pinned Skip/Reply footer. The card itself never
    // scrolls (overflow hidden), so a tall ask clips inside the scroll region
    // and the footer stays put — Reply is reachable at any viewport height.
    expect(dialog.style.overflow).toBe("hidden");
    const [scrollRegion, footer] = [...dialog.children] as HTMLElement[];
    if (!scrollRegion || !footer) throw new Error("expected a scroll region and a pinned footer");

    // Scroll region: the only scroller — flex-grows and clips with overflow-y auto.
    expect(scrollRegion.style.overflowY).toBe("auto");
    expect(scrollRegion.style.flex).toBe("1 1 auto");
    expect(scrollRegion.style.minHeight).toMatch(/^0(px)?$/);
    expect(scrollRegion.textContent).toContain("Paragraph line 0");
    expect(scrollRegion.textContent).toContain("Paragraph line 199");

    // The options live INSIDE the scroller, alongside the body — so a long ask
    // plus many options can never push the controls off-screen.
    const ship = option(c, "Ship");
    if (!ship) throw new Error("option missing");
    expect(scrollRegion.contains(ship)).toBe(true);
    expect(footer.contains(ship)).toBe(false);

    // Pinned footer: does not grow, does not scroll, and holds the Skip/Reply
    // actions — so they stay reachable while the body + options scroll.
    expect(footer.style.flex).toBe("0 0 auto");
    expect(footer.style.overflowY).toBe("");
    const reply = btn(c, "Reply");
    const skip = btn(c, "Skip");
    if (!reply || !skip) throw new Error("actions missing");
    for (const el of [reply, skip]) {
      expect(footer.contains(el)).toBe(true);
      expect(scrollRegion.contains(el)).toBe(false);
    }
  });

  it("Skip calls onSkip and never resolves (no onReply)", async () => {
    const onReply = vi.fn();
    const onSkip = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# x" payload={{ multiSelect: false, options: OPTS }} onReply={onReply} onSkip={onSkip} />,
    );
    await click(btn(c, "Skip"));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onReply).not.toHaveBeenCalled();
  });
});
