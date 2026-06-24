// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ChatSummary, descriptionFirstLine } from "../chat-summary.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `descriptionFirstLine` powers the collapsed chat-summary bar: it picks the
 * first content line of the chat description and strips the common markdown
 * markers so a `- bullet` reads as plain text (visual truncation is left to
 * CSS). A leading section heading (`## 任务`) is skipped in favor of the prose
 * below it, falling back to the heading only when there is nothing else. It
 * must also degrade gracefully past structural-only lines.
 */
describe("descriptionFirstLine", () => {
  it("prefers the first content line over a leading section heading", () => {
    expect(descriptionFirstLine("## Goals\nbody")).toBe("body");
  });

  it("degrades a section-label heading to the prose below it", () => {
    expect(descriptionFirstLine("## 任务\n把右侧 summary 改为任务头")).toBe("把右侧 summary 改为任务头");
  });

  it("skips multiple stacked headings to reach the prose", () => {
    expect(descriptionFirstLine("# Title\n## Section\nThe real summary")).toBe("The real summary");
  });

  it("falls back to the heading when the description is only heading(s)", () => {
    expect(descriptionFirstLine("# Just a title")).toBe("Just a title");
  });

  it("strips a leading bullet", () => {
    expect(descriptionFirstLine("- first item")).toBe("first item");
  });

  it("strips an ordered-list marker", () => {
    expect(descriptionFirstLine("1. step one")).toBe("step one");
  });

  it("strips inline emphasis and inline code", () => {
    expect(descriptionFirstLine("**Status**: `done` soon")).toBe("Status: done soon");
  });

  it("preserves literal underscores in content (snake_case identifiers are not mangled)", () => {
    expect(descriptionFirstLine("- `description_updated_at` lands")).toBe("description_updated_at lands");
  });

  it("strips emphasis markers but keeps an underscored identifier inside them", () => {
    expect(descriptionFirstLine("**foo_bar_baz** done")).toBe("foo_bar_baz done");
  });

  it("renders a link as its text", () => {
    expect(descriptionFirstLine("see [the PR](https://x/y) now")).toBe("see the PR now");
  });

  it("strips a blockquote marker", () => {
    expect(descriptionFirstLine("> quoted line")).toBe("quoted line");
  });

  it("skips blank lines and uses the first line with content", () => {
    expect(descriptionFirstLine("\n   \nReal first line")).toBe("Real first line");
  });

  it("skips a leading thematic break / horizontal rule", () => {
    expect(descriptionFirstLine("---\nAfter the rule")).toBe("After the rule");
  });

  it("skips a table delimiter row but keeps the header row", () => {
    expect(descriptionFirstLine("| Col A | Col B |\n| --- | --- |")).toBe("Col A | Col B |");
  });

  it("collapses internal whitespace", () => {
    expect(descriptionFirstLine("a    b\tc")).toBe("a b c");
  });

  it("returns an empty string for an all-whitespace description", () => {
    expect(descriptionFirstLine("   \n\n  ")).toBe("");
  });
});

describe("ChatSummary", () => {
  const readRecentlyAt = "2026-05-28T12:00:00.000Z";
  const unreadVersionAt = "2026-05-28T12:01:00.000Z";
  const newerUnreadVersionAt = "2026-05-28T12:02:00.000Z";

  type SummaryProps = Parameters<typeof ChatSummary>[0];

  function summaryProps(scrollEl: HTMLDivElement, overrides: Partial<SummaryProps> = {}): SummaryProps {
    return {
      chatId: "chat-1",
      description: "Status: shipping **DescBody** soon.",
      descriptionUpdatedAt: null,
      lastReadAt: null,
      freshnessReady: true,
      scrollContainerRef: { current: scrollEl },
      ...overrides,
    };
  }

  async function renderSummary(
    scrollEl: HTMLDivElement,
    overrides: Partial<SummaryProps> = {},
  ): Promise<{ container: HTMLDivElement; root: Root; rerender: (next: Partial<SummaryProps>) => Promise<void> }> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    let props = summaryProps(scrollEl, overrides);
    await act(async () => {
      root.render(createElement(ChatSummary, props));
    });
    return {
      container,
      root,
      rerender: async (next: Partial<SummaryProps>) => {
        props = { ...props, ...next };
        await act(async () => {
          root.render(createElement(ChatSummary, props));
        });
      },
    };
  }

  // A wheel event the summary's native (non-passive) listener can read. Built
  // from a plain cancelable Event so the test does not depend on happy-dom's
  // WheelEvent constructor; deltaX/deltaY are the only fields the handler reads.
  function wheelEvent(deltaY: number, deltaX = 0): Event {
    const e = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "deltaY", { value: deltaY });
    Object.defineProperty(e, "deltaX", { value: deltaX });
    return e;
  }

  it("auto-expands an unread summary version on entry even when the chat was read recently", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]')?.textContent).toContain(
      "Summary",
    );
    expect(container.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => root.unmount());
    container.remove();
  });

  it("does not auto-expand the same unread summary version after the user manually collapses it", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const unreadProps = {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    };
    const first = await renderSummary(scrollEl, unreadProps);
    const collapseButton = first.container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]');
    if (!collapseButton) throw new Error("summary collapse button missing");
    await act(async () => {
      collapseButton.click();
    });
    await act(async () => first.root.unmount());
    first.container.remove();

    const second = await renderSummary(scrollEl, unreadProps);
    expect(second.container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]')).not.toBeNull();
    expect(second.container.querySelector("strong")).toBeNull();
    expect(second.container.textContent).toContain("Updated");

    await act(async () => second.root.unmount());
    second.container.remove();
  });

  it("keeps the current mounted chat collapsed when a newer unread summary version arrives", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, root, rerender } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: readRecentlyAt,
      lastReadAt: unreadVersionAt,
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]')).not.toBeNull();

    await rerender({
      descriptionUpdatedAt: newerUnreadVersionAt,
      lastReadAt: unreadVersionAt,
    });

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]')).not.toBeNull();
    expect(container.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("Updated");

    await act(async () => root.unmount());
    container.remove();
  });

  it("keeps a manual expand open when the stream was already scrolled", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 120;
    const { container, root } = await renderSummary(scrollEl);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]');
    if (!button) throw new Error("summary button missing");

    await act(async () => {
      button.click();
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]')?.textContent).toContain(
      "Summary",
    );
    expect(container.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => root.unmount());
    container.remove();
  });

  it("still collapses after a fresh downward scroll from a manual expand point", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 120;
    const { container, root } = await renderSummary(scrollEl);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]');
    if (!button) throw new Error("summary button missing");

    await act(async () => {
      button.click();
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]')?.textContent).toContain(
      "Summary",
    );
    expect(container.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => {
      scrollEl.scrollTop = 170;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("does not auto-expand a sticky-collapsed summary when scrolling back to the top", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]')).not.toBeNull();

    await act(async () => {
      scrollEl.scrollTop = 120;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]')).not.toBeNull();
    expect(container.querySelector("strong")).toBeNull();

    await act(async () => {
      scrollEl.scrollTop = 0;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]')).not.toBeNull();
    expect(container.querySelector("strong")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it("expands on the first click from the sticky-collapsed bar", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, root } = await renderSummary(scrollEl);
    const initialButton = container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]');
    if (!initialButton) throw new Error("summary button missing");

    await act(async () => {
      initialButton.click();
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]')?.textContent).toContain(
      "Summary",
    );
    expect(container.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => {
      scrollEl.scrollTop = 120;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector("strong")).toBeNull();

    const stickyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Expand summary"]');
    if (!stickyButton) throw new Error("sticky summary button missing");
    await act(async () => {
      stickyButton.click();
    });
    expect(container.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => root.unmount());
    container.remove();
  });

  it("bridges a wheel gesture over the expanded summary to the message stream", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 0;
    // Unread version → auto-expanded on entry, so the panel owns the viewport.
    const { container, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]')).not.toBeNull();
    const panel = container.firstElementChild as HTMLElement | null;
    if (!panel) throw new Error("summary panel missing");

    // The expanded body cannot absorb the scroll itself (no overflow), so a wheel
    // over the summary must drive the message stream — without this it scrolls
    // nothing and the conversation reads as "locked".
    await act(async () => {
      panel.dispatchEvent(wheelEvent(120));
    });
    expect(scrollEl.scrollTop).toBe(120);

    await act(async () => root.unmount());
    container.remove();
  });

  it("scrolls the summary body itself before driving the stream", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 0;
    const { container, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    const panel = container.firstElementChild as HTMLElement | null;
    if (!panel) throw new Error("summary panel missing");
    const inner = container.querySelector<HTMLElement>('[style*="46vh"]');
    if (!inner) throw new Error("summary scroll body missing");
    // Make the body itself scrollable and parked mid-content (not at top/bottom).
    Object.defineProperty(inner, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(inner, "clientHeight", { value: 200, configurable: true });
    inner.scrollTop = 100;

    // Wheel up: the body can still scroll up, so the body moves and the stream
    // stays put.
    await act(async () => {
      panel.dispatchEvent(wheelEvent(-40));
    });
    expect(inner.scrollTop).toBe(60);
    expect(scrollEl.scrollTop).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("scrolls the body for a wheel over the summary header, not just the body", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 0;
    const { container, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    // The header control sits OUTSIDE the markdown body's event path; a wheel
    // there must still drive the body while it has room (regression: target-
    // unaware deferral to native scroll left the header strip locked).
    const header = container.querySelector<HTMLButtonElement>('button[aria-label="Collapse summary"]');
    if (!header) throw new Error("summary header button missing");
    const inner = container.querySelector<HTMLElement>('[style*="46vh"]');
    if (!inner) throw new Error("summary scroll body missing");
    Object.defineProperty(inner, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(inner, "clientHeight", { value: 200, configurable: true });
    inner.scrollTop = 0;

    await act(async () => {
      header.dispatchEvent(wheelEvent(120));
    });
    expect(inner.scrollTop).toBe(120);
    expect(scrollEl.scrollTop).toBe(0);

    await act(async () => root.unmount());
    container.remove();
  });

  it("leaves a horizontal-dominant wheel to the browser", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 0;
    const { container, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    const panel = container.firstElementChild as HTMLElement | null;
    if (!panel) throw new Error("summary panel missing");
    const inner = container.querySelector<HTMLElement>('[style*="46vh"]');
    if (!inner) throw new Error("summary scroll body missing");
    // Body is scrollable, so a missing guard would let the small vertical
    // component move it.
    Object.defineProperty(inner, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(inner, "clientHeight", { value: 200, configurable: true });
    inner.scrollTop = 100;

    // deltaX dominates deltaY (a trackpad horizontal pan): hands off to the
    // browser — nothing is scrolled and the event is not consumed.
    const ev = wheelEvent(8, 120);
    await act(async () => {
      panel.dispatchEvent(ev);
    });
    expect(inner.scrollTop).toBe(100);
    expect(scrollEl.scrollTop).toBe(0);
    expect(ev.defaultPrevented).toBe(false);

    await act(async () => root.unmount());
    container.remove();
  });
});
