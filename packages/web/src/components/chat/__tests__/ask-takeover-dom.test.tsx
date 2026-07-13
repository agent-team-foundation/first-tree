// @vitest-environment happy-dom

import { MAX_ATTACHMENT_BYTES } from "@first-tree/shared";
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

// usePendingAttachments stages a revocable object-URL per image; give the test a
// deterministic, side-effect-free implementation regardless of happy-dom's.
URL.createObjectURL = () => "blob:mock";
URL.revokeObjectURL = () => {};

const OPTS = [
  { label: "Ship", description: "ship now", preview: "ft deploy --to 20" },
  { label: "Hold", description: "wait 24h" },
];

const CANDIDATES = [{ agentId: "agent-alice", name: "alice", displayName: "Alice", managedByMe: false }];

const roots: Root[] = [];
function installImmediateAnimationFrame(): () => void {
  const original = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    callback(0);
    return 1;
  };
  return () => {
    if (original) {
      globalThis.requestAnimationFrame = original;
    } else {
      delete (globalThis as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame;
    }
  };
}
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
  act(() => {
    for (const r of roots.splice(0)) r.unmount();
  });
  document.body.innerHTML = "";
});

async function click(el: Element | null): Promise<void> {
  if (!el) throw new Error("Expected element to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}
async function keyDown(el: EventTarget, key: string, init: KeyboardEventInit = {}): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}
async function mouseDown(el: EventTarget): Promise<MouseEvent> {
  const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}
async function setValue(el: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
  });
}
async function changeFiles(el: HTMLInputElement, files: File[]): Promise<void> {
  await act(async () => {
    Object.defineProperty(el, "files", { configurable: true, value: files });
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function pasteFiles(el: Element | null, files: File[]): Promise<Event> {
  if (!el) throw new Error("paste target missing");
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { configurable: true, value: { files } });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}
async function dragOver(el: Element | null): Promise<Event> {
  if (!el) throw new Error("drag target missing");
  const event = new Event("dragover", { bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}
async function dropFiles(el: Element | null, files: File[]): Promise<Event> {
  if (!el) throw new Error("drop target missing");
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { configurable: true, value: { files } });
  await act(async () => {
    el.dispatchEvent(event);
  });
  return event;
}
function freeTextBox(c: ParentNode): HTMLTextAreaElement | null {
  return c.querySelector<HTMLTextAreaElement>(
    'textarea[placeholder^="Type your answer"], textarea[placeholder^="Other"]',
  );
}
function answerSurface(c: ParentNode): HTMLElement | null {
  const textarea = freeTextBox(c);
  return textarea?.parentElement?.parentElement ?? null;
}
function thumbnails(c: ParentNode): HTMLImageElement[] {
  return [...c.querySelectorAll<HTMLImageElement>("img")];
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
  it("lifts above the visual viewport keyboard inset and unregisters viewport listeners", async () => {
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
    const visualViewport = {
      height: 500,
      offsetTop: 25,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        const set = listeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
        set.add(listener);
        listeners.set(type, set);
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(listener);
      }),
    };
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });

    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={() => {}} onSkip={() => {}} />,
    );
    const scrim = c.firstElementChild;
    if (!(scrim instanceof HTMLElement)) throw new Error("scrim missing");
    expect(Number.parseFloat(scrim.style.bottom)).toBe(195);

    visualViewport.height = 690;
    visualViewport.offsetTop = 20;
    await act(async () => {
      for (const listener of listeners.get("resize") ?? []) {
        if (typeof listener === "function") listener(new Event("resize"));
        else listener.handleEvent(new Event("resize"));
      }
    });
    expect(Number.parseFloat(scrim.style.bottom)).toBe(10);

    await act(async () => {
      for (const r of roots.splice(0)) r.unmount();
    });
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(visualViewport.removeEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
    Object.defineProperty(window, "visualViewport", { configurable: true, value: undefined });
  });

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
    expect(onReply).toHaveBeenCalledWith({ content: "Hold", mentions: [], images: [] });
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
    expect(onReply).toHaveBeenCalledWith({ content: "Ship, Hold", mentions: [], images: [] });
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
    expect(onReply).toHaveBeenCalledWith({ content: "Ship\nbut watch the canary", mentions: [], images: [] });
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
    expect(onReply).toHaveBeenCalledWith({ content: "looks risky", mentions: [], images: [] });
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

  it("Esc resolves with Skip; Enter resolves with Reply once the answer is valid", async () => {
    const onReply = vi.fn();
    const onSkip = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={onReply} onSkip={onSkip} />,
    );
    const ta = c.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!ta) throw new Error("free-text input missing");

    // Enter is inert while Reply is gated (no text yet).
    await keyDown(ta, "Enter");
    expect(onReply).not.toHaveBeenCalled();

    await setValue(ta, "looks risky");
    const entered = await keyDown(ta, "Enter");
    expect(onReply).toHaveBeenCalledWith({ content: "looks risky", mentions: [], images: [] });
    expect(entered.defaultPrevented).toBe(true); // no newline gets inserted

    // Esc skips, regardless of focus / typed text.
    await keyDown(ta, "Escape");
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("Shift+Enter and IME composition do not resolve (newline / candidate confirm)", async () => {
    const onReply = vi.fn();
    const onSkip = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={onReply} onSkip={onSkip} />,
    );
    const ta = c.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "draft");

    const shiftEnter = await keyDown(ta, "Enter", { shiftKey: true });
    expect(onReply).not.toHaveBeenCalled();
    expect(shiftEnter.defaultPrevented).toBe(false); // newline stands

    // Mid-IME-composition Enter confirms the candidate, never resolves.
    await keyDown(ta, "Enter", { isComposing: true });
    expect(onReply).not.toHaveBeenCalled();
    // Esc during composition cancels the candidate, never skips.
    await keyDown(ta, "Escape", { isComposing: true });
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("Enter on an option row toggles it rather than resolving", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Pick" payload={{ multiSelect: false, options: OPTS }} onReply={onReply} onSkip={() => {}} />,
    );
    const ship = option(c, "Ship");
    if (!ship) throw new Error("option missing");
    await keyDown(ship, "Enter");
    expect(onReply).not.toHaveBeenCalled();
  });

  it("Enter and Esc are inert while sending", async () => {
    const onReply = vi.fn();
    const onSkip = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} sending onReply={onReply} onSkip={onSkip} />,
    );
    const ta = c.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "looks risky");
    await keyDown(ta, "Enter");
    await keyDown(ta, "Escape");
    expect(onReply).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
  });

  it("stays inert while a higher overlay owns the keystroke (aria-hidden region)", async () => {
    const onReply = vi.fn();
    const onSkip = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={onReply} onSkip={onSkip} />,
    );
    const ta = c.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "looks risky");

    // Simulate a modal layered above the card (e.g. the ⌘K command palette,
    // a Radix dialog) by marking the card's container aria-hidden, exactly as
    // Radix's focus scope does to the rest of the tree while a dialog is open.
    // Enter/Escape now belong to that overlay and must not resolve the ask.
    c.setAttribute("aria-hidden", "true");
    await keyDown(ta, "Enter");
    await keyDown(ta, "Escape");
    expect(onReply).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();

    // Once the overlay closes (aria-hidden cleared), the shortcuts resume.
    c.removeAttribute("aria-hidden");
    await keyDown(ta, "Enter");
    expect(onReply).toHaveBeenCalledWith({ content: "looks risky", mentions: [], images: [] });
  });

  it("resolves free-text `@<name>` tokens to agentIds against the candidates", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover
        body="# Who?"
        payload={{ multiSelect: false }}
        mentionCandidates={CANDIDATES}
        onReply={onReply}
        onSkip={() => {}}
      />,
    );
    const ta = freeTextBox(c);
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "@alice please confirm");
    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith({
      content: "@alice please confirm",
      mentions: ["agent-alice"],
      images: [],
    });
  });

  it("renders the `@` autocomplete popover when the caret sits in an `@` query", async () => {
    const c = await renderDom(
      <AskTakeover
        body="# Who?"
        payload={{ multiSelect: false }}
        mentionCandidates={CANDIDATES}
        onReply={() => {}}
        onSkip={() => {}}
      />,
    );
    const ta = freeTextBox(c);
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "@al");
    // The popover is a listbox of candidate rows anchored to the textarea.
    const listbox = c.querySelector('[role="listbox"]');
    expect(listbox?.textContent).toContain("Alice");
  });

  it("commits a mention from the popover and through the explicit mention button", async () => {
    const restoreRaf = installImmediateAnimationFrame();
    try {
      const c = await renderDom(
        <AskTakeover
          body="# Who?"
          payload={{ multiSelect: false }}
          mentionCandidates={CANDIDATES}
          onReply={() => {}}
          onSkip={() => {}}
        />,
      );
      const ta = freeTextBox(c);
      if (!ta) throw new Error("free-text input missing");
      await setValue(ta, "@al");
      const alice = c.querySelector<HTMLElement>('[role="option"]');
      if (!alice) throw new Error("mention option missing");
      const picked = await mouseDown(alice);
      expect(picked.defaultPrevented).toBe(true);
      expect(ta.value).toBe("@alice ");

      await act(async () => {
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.dispatchEvent(new Event("select", { bubbles: true }));
      });
      await click(c.querySelector('[aria-label="Mention an agent"]'));
      expect(ta.value).toBe("@alice @");
    } finally {
      restoreRaf();
    }
  });

  it("stages a pasted/attached image and lets an image-only answer resolve", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Evidence?" payload={{ multiSelect: false }} onReply={onReply} onSkip={() => {}} />,
    );
    // No text yet → Reply gated.
    expect(btn(c, "Reply")?.disabled).toBe(true);

    const file = new File(["x"], "shot.png", { type: "image/png" });
    const fileInput = c.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("file input missing");
    await changeFiles(fileInput, [file]);

    // A thumbnail appears and an image alone now satisfies Reply.
    expect(thumbnails(c).length).toBe(1);
    expect(btn(c, "Reply")?.disabled).toBe(false);

    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith({ content: "", mentions: [], images: [file] });
  });

  it("stages an attached document and includes it in the reply", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Evidence?" payload={{ multiSelect: false }} onReply={onReply} onSkip={() => {}} />,
    );

    const file = new File(["a,b\n1,2"], "evidence.csv", { type: "text/csv" });
    const fileInput = c.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("file input missing");
    await changeFiles(fileInput, [file]);

    expect(c.textContent).toContain("evidence.csv");
    expect(btn(c, "Reply")?.disabled).toBe(false);

    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith({
      content: "",
      mentions: [],
      images: [],
      attachments: [{ file, kind: "file" }],
    });
  });

  it("opens the file picker, stages pasted and dropped images, and removes thumbnails", async () => {
    const c = await renderDom(
      <AskTakeover body="# Evidence?" payload={{ multiSelect: false }} onReply={() => {}} onSkip={() => {}} />,
    );
    const fileInput = c.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("file input missing");
    const openPicker = vi.spyOn(fileInput, "click");
    await click(c.querySelector('[aria-label="Attach file"]'));
    expect(openPicker).toHaveBeenCalledTimes(1);

    const pasted = new File(["paste"], "paste.png", { type: "image/png" });
    const ta = freeTextBox(c);
    const paste = await pasteFiles(ta, [pasted]);
    expect(paste.defaultPrevented).toBe(true);
    expect(thumbnails(c).map((img) => img.alt)).toEqual(["paste.png"]);

    const removed = c.querySelector<HTMLButtonElement>('[aria-label="Remove image"]');
    await click(removed);
    expect(thumbnails(c)).toEqual([]);

    const dropped = new File(["drop"], "drop.png", { type: "image/png" });
    const drag = await dragOver(answerSurface(c));
    expect(drag.defaultPrevented).toBe(true);
    const drop = await dropFiles(answerSurface(c), [dropped]);
    expect(drop.defaultPrevented).toBe(true);
    expect(thumbnails(c).map((img) => img.alt)).toEqual(["drop.png"]);
  });

  it("keeps the trial answer input plain by ignoring mention, paste, and drop affordances", async () => {
    const c = await renderDom(
      <AskTakeover body="# Evidence?" isTrial payload={{ multiSelect: false }} onReply={() => {}} onSkip={() => {}} />,
    );
    expect(c.querySelector('[aria-label="Mention an agent"]')).toBeNull();
    expect(c.querySelector('[aria-label="Attach file"]')).toBeNull();

    const file = new File(["x"], "trial.png", { type: "image/png" });
    const paste = await pasteFiles(freeTextBox(c), [file]);
    const drag = await dragOver(answerSurface(c));
    const drop = await dropFiles(answerSurface(c), [file]);
    expect(paste.defaultPrevented).toBe(false);
    expect(drag.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(thumbnails(c)).toEqual([]);
  });

  it("rejects an oversized image with an error and stages nothing", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Evidence?" payload={{ multiSelect: false }} onReply={onReply} onSkip={() => {}} />,
    );
    // One byte over the per-attachment cap usePendingAttachments enforces.
    const big = new File([new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1)], "big.png", { type: "image/png" });
    const fileInput = c.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("file input missing");
    await changeFiles(fileInput, [big]);

    expect(c.textContent).toContain("too large");
    expect(thumbnails(c).length).toBe(0);
    expect(btn(c, "Reply")?.disabled).toBe(true);
  });

  it("stages supported files while surfacing unsupported files from the same selection", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Evidence?" payload={{ multiSelect: false }} onReply={onReply} onSkip={() => {}} />,
    );
    const fileInput = c.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) throw new Error("file input missing");
    const valid = new File(["a,b\n1,2"], "valid.csv", { type: "text/csv" });
    const invalid = new File(["zip"], "payload.zip", { type: "application/zip" });

    await changeFiles(fileInput, [valid, invalid]);

    expect(c.querySelector('[title="valid.csv"]')).not.toBeNull();
    expect(c.textContent).toContain("Unsupported file type: payload.zip");
    await click(btn(c, "Reply"));
    expect(onReply).toHaveBeenCalledWith({
      content: "",
      mentions: [],
      images: [],
      attachments: [{ file: valid, kind: "file" }],
    });
  });

  it("surfaces a host send error inside the card", async () => {
    const c = await renderDom(
      <AskTakeover
        body="# Concerns?"
        payload={{ multiSelect: false }}
        error="Failed to send your answer"
        onReply={() => {}}
        onSkip={() => {}}
      />,
    );
    expect(c.textContent).toContain("Failed to send your answer");
  });

  it("yields to a focused control that already consumed the keystroke (defaultPrevented)", async () => {
    const onReply = vi.fn();
    const onSkip = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={onReply} onSkip={onSkip} />,
    );
    const ta = c.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Type your answer"]');
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "looks risky");

    // A focused popover (mention/slash autocomplete) consumes Enter/Escape
    // before the window listener sees it; the ask must not also resolve.
    const consume = (e: Event) => e.preventDefault();
    ta.addEventListener("keydown", consume);
    await keyDown(ta, "Enter");
    await keyDown(ta, "Escape");
    expect(onReply).not.toHaveBeenCalled();
    expect(onSkip).not.toHaveBeenCalled();
    ta.removeEventListener("keydown", consume);
  });

  it("free-text answer surface stays transparent so the mention overlay shows the typed text", async () => {
    // Regression guard (PR 1256): the answer textarea is painted transparent and
    // a mirror overlay behind it draws the glyphs. If the textarea keeps an
    // opaque background it sits on top of the overlay and the typed text turns
    // invisible — the white-on-white bug on the light theme. The visible chrome
    // (border + fill) must live on the wrapper, not the textarea.
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={() => {}} onSkip={() => {}} />,
    );
    const ta = freeTextBox(c);
    if (!ta) throw new Error("free-text input missing");
    expect(ta.style.background).toBe("transparent");
    expect(ta.style.color).toBe("transparent");
    // The mirror overlay that actually paints the glyphs is a sibling.
    expect(ta.parentElement?.querySelector("[aria-hidden]")).not.toBeNull();
    // The opaque fill now lives on the wrapper so the field still reads as a box.
    expect(ta.parentElement?.style.background).toBe("var(--bg)");
  });

  it("mobile: enlarged tap targets, Enter does not reply (Reply button is the only submit)", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={onReply} onSkip={() => {}} mobile />,
    );
    const reply = btn(c, "Reply");
    const atBtn = c.querySelector<HTMLButtonElement>('button[aria-label="Mention an agent"]');
    const attachBtn = c.querySelector<HTMLButtonElement>('button[aria-label="Attach file"]');
    if (!reply || !atBtn || !attachBtn) throw new Error("Mobile ask controls missing");
    // Tap targets clear the touch minimum.
    expect(Number.parseInt(reply.style.height, 10)).toBe(44);
    expect(Number.parseInt(atBtn.style.width, 10)).toBe(44);
    expect(Number.parseInt(attachBtn.style.width, 10)).toBe(44);

    // Enter inserts a newline (does not resolve); the Reply button submits.
    const ta = freeTextBox(c);
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "looks risky");
    await keyDown(window, "Enter");
    expect(onReply).not.toHaveBeenCalled();
    await click(reply);
    expect(onReply).toHaveBeenCalledWith({ content: "looks risky", mentions: [], images: [] });
  });

  it("desktop: compact controls and Enter resolves the ask", async () => {
    const onReply = vi.fn();
    const c = await renderDom(
      <AskTakeover body="# Concerns?" payload={{ multiSelect: false }} onReply={onReply} onSkip={() => {}} />,
    );
    const reply = btn(c, "Reply");
    if (!reply) throw new Error("Reply button missing");
    expect(Number.parseInt(reply.style.height, 10)).toBe(34);
    const ta = freeTextBox(c);
    if (!ta) throw new Error("free-text input missing");
    await setValue(ta, "looks risky");
    await keyDown(window, "Enter");
    expect(onReply).toHaveBeenCalledWith({ content: "looks risky", mentions: [], images: [] });
  });

  it("narrow: portals the @picker, then dismisses it (no hidden Enter selection) when the field leaves its scrollport", async () => {
    // Controlled rAF (the portal loop reschedules itself, so an immediate rAF
    // would recurse); drive one frame manually after moving the field.
    let rafCb: FrameRequestCallback | null = null;
    const origRaf = globalThis.requestAnimationFrame;
    const origCancel = globalThis.cancelAnimationFrame;
    const origMatchMedia = window.matchMedia;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    };
    globalThis.cancelAnimationFrame = () => {
      rafCb = null;
    };
    // Force the phone-width viewport so AskTakeover opts into portal mode
    // (useWorkspaceViewport → "narrow" when no wider query matches).
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    // Mutable field rect (starts inside the scrollport); the answer scroller is
    // the element with inline `overflow-y: auto`.
    const field = { top: 300, bottom: 340, left: 20, right: 340, width: 320, height: 40 };
    const PORT = { top: 100, bottom: 500, left: 0, right: 360, width: 360, height: 400 } as DOMRect;
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains("ask-answer-field")) return field as DOMRect;
      if (this.style?.overflowY === "auto") return PORT;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      if ((el as HTMLElement).style?.overflowY === "auto") return { overflowY: "auto" } as CSSStyleDeclaration;
      return realGetComputedStyle(el);
    });

    try {
      const c = await renderDom(
        <AskTakeover
          body="# Pick"
          payload={{ multiSelect: false }}
          mentionCandidates={CANDIDATES}
          onReply={() => {}}
          onSkip={() => {}}
        />,
      );
      const ta = freeTextBox(c);
      if (!ta) throw new Error("free-text input missing");
      await setValue(ta, "@");

      // AskTakeover wired `portal`: a body-portaled picker appears (not in-flow).
      const panel = document.body.querySelector<HTMLElement>('[role="listbox"]');
      expect(panel).not.toBeNull();
      expect(panel?.classList.contains("mention-popover--portal")).toBe(true);

      // Field scrolls fully above its scrollport top → picker dismissed.
      field.top = 10;
      field.bottom = 50;
      await act(async () => rafCb?.(0));
      expect(document.body.querySelector('[role="listbox"]')).toBeNull();

      // AskTakeover wired `onDismiss`: Enter now commits nothing (no hidden row).
      await keyDown(ta, "Enter");
      expect(ta.value).toBe("@");
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancel;
      window.matchMedia = origMatchMedia;
    }
  });
});
