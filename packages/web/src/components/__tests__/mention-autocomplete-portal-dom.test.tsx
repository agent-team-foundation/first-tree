// @vitest-environment happy-dom

import { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MentionAutocompletePopover, type MentionCandidate, useMentionAutocomplete } from "../mention-autocomplete.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Portal-mode lifecycle contracts (AskTakeover's clip-escaping `@` picker),
 * guarded against regression:
 *   1. a field scrolled fully out of its inner scrollport dismisses the picker,
 *      so Enter can't commit a hidden candidate;
 *   2. a coordinate-only field move (no scroll/resize/size change) is followed
 *      on the next animation frame;
 *   3. near the viewport top the panel height is clamped to the space above the
 *      field (so its first/active row never renders off-screen), and dismisses
 *      when there isn't room for even one row.
 *
 * happy-dom has no layout, so element rects, the scrollport lookup, and rAF are
 * stubbed deterministically.
 */

type RectLike = { top: number; bottom: number; left: number; right: number; width: number; height: number };

const twoCandidates: MentionCandidate[] = [
  { agentId: "a1", name: "alice", displayName: "alice", managedByMe: false },
  { agentId: "a2", name: "bob", displayName: "bob", managedByMe: false },
];

let harnessCandidates: MentionCandidate[];
let picked: Array<{ text: string; cursor: number }>;
let fieldRect: RectLike;
let portRect: RectLike;
let rafCb: FrameRequestCallback | null;

function Harness() {
  const taRef = useRef<HTMLTextAreaElement>(null);
  // Re-render once after mount so `open` recomputes with the textarea ref
  // attached (mirrors a real `@` keystroke re-render).
  const [, force] = useState(0);
  useEffect(() => force(1), []);
  const mention = useMentionAutocomplete({
    value: "@",
    cursor: 1,
    candidates: harnessCandidates,
    onSelect: (u) => picked.push(u),
  });
  return (
    <div data-scroll style={{ overflowY: "auto" }}>
      <div data-field>
        <MentionAutocompletePopover
          trigger={mention.trigger}
          results={mention.results}
          highlightIndex={mention.highlightIndex}
          anchorRef={taRef}
          onPick={mention.pick}
          portal
          onDismiss={mention.dismiss}
        />
        <textarea data-ta ref={taRef} onKeyDown={(e) => mention.handleKey(e)} />
      </div>
    </div>
  );
}

function mount(): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Harness />));
  return { container, root };
}

const listbox = () => document.body.querySelector<HTMLElement>('[role="listbox"]');
const px = (v: string) => Number.parseInt(v, 10);
const flushFrame = () => {
  const cb = rafCb;
  rafCb = null;
  if (cb) act(() => cb(0));
};

describe("MentionAutocompletePopover portal lifecycle", () => {
  beforeEach(() => {
    harnessCandidates = twoCandidates;
    picked = [];
    fieldRect = { top: 400, bottom: 440, left: 20, right: 340, width: 320, height: 40 };
    portRect = { top: 100, bottom: 500, left: 0, right: 360, width: 360, height: 400 };
    rafCb = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      rafCb = cb;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {
      rafCb = null;
    });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-field")) return fieldRect as DOMRect;
      if (this.hasAttribute("data-scroll")) return portRect as DOMRect;
      return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    });
    const realGetComputedStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => {
      if (el.hasAttribute?.("data-scroll")) return { overflowY: "auto" } as CSSStyleDeclaration;
      return realGetComputedStyle(el);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("renders the portal listbox docked above the field when it is in view", () => {
    const { root } = mount();
    expect(listbox()).not.toBeNull();
    expect(px(listbox()?.style.bottom ?? "")).toBe(400); // innerHeight(800) - field.top(400)
    act(() => root.unmount());
  });

  it("dismisses when the field is out of its scrollport, and Enter then selects nothing", () => {
    fieldRect = { ...fieldRect, top: 40, bottom: 90 }; // fully above the scrollport top (bottom <= 100)
    const { container, root } = mount();

    expect(listbox()).toBeNull();

    const ta = container.querySelector<HTMLTextAreaElement>("[data-ta]");
    act(() => {
      ta?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(picked).toHaveLength(0);
    act(() => root.unmount());
  });

  it("follows a coordinate-only field move on the next animation frame", () => {
    const { root } = mount();
    expect(px(listbox()?.style.bottom ?? "")).toBe(400);

    fieldRect = { ...fieldRect, top: 300, bottom: 340 }; // moved up 100; no scroll/resize/size change
    flushFrame();

    expect(px(listbox()?.style.bottom ?? "")).toBe(500); // 800 - 300
    act(() => root.unmount());
  });

  it("clamps the panel height to the space above the field near the viewport top", () => {
    // Scrollport reaches the viewport top; field sits 60 below it — in the
    // scrollport, but with only 60 of usable space above.
    portRect = { ...portRect, top: 0 };
    fieldRect = { ...fieldRect, top: 60, bottom: 100 };
    const { root } = mount();
    expect(listbox()).not.toBeNull();
    expect(px(listbox()?.style.maxHeight ?? "")).toBe(60); // clamped, not the 16rem cap
    act(() => root.unmount());
  });

  it("dismisses when there isn't room above the field for even the active row", () => {
    portRect = { ...portRect, top: 0 };
    fieldRect = { ...fieldRect, top: 30, bottom: 70 }; // 30 < one row (46)
    const { container, root } = mount();
    expect(listbox()).toBeNull();

    const ta = container.querySelector<HTMLTextAreaElement>("[data-ta]");
    act(() => {
      ta?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(picked).toHaveLength(0);
    act(() => root.unmount());
  });

  it("re-scrolls the active row into view when a geometry-only clamp shrinks the panel", () => {
    // Eight candidates, scrollport from the viewport top so the field can move
    // near the top and shrink the clamp.
    harnessCandidates = Array.from({ length: 8 }, (_, i) => ({
      agentId: `a${i}`,
      name: `n${i}`,
      displayName: `n${i}`,
      managedByMe: false,
    }));
    portRect = { ...portRect, top: 0 };
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
    const { container, root } = mount();
    const ta = container.querySelector<HTMLTextAreaElement>("[data-ta]");

    // Highlight a later row (7th) — field is far from the top, panel is tall.
    for (let i = 0; i < 6; i++) {
      act(() => ta?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    }
    scrollSpy.mockClear();

    // Coordinate-only move toward the viewport top → maxHeight clamps 256 → 60,
    // highlight index unchanged. The active row must be re-scrolled into view.
    fieldRect = { ...fieldRect, top: 60, bottom: 100 };
    flushFrame();

    expect(px(listbox()?.style.maxHeight ?? "")).toBe(60);
    expect(scrollSpy).toHaveBeenCalled();
    act(() => root.unmount());
  });
});
