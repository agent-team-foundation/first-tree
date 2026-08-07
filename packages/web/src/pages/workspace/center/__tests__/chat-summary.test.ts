// @vitest-environment happy-dom

import { act, createElement, StrictMode } from "react";
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

  function summaryProps(
    scrollEl: HTMLDivElement,
    overlayEl: HTMLDivElement,
    overrides: Partial<SummaryProps> = {},
  ): SummaryProps {
    return {
      chatId: "chat-1",
      description: "Status: shipping **DescBody** soon.",
      descriptionUpdatedAt: null,
      lastReadAt: null,
      freshnessReady: true,
      scrollContainerRef: { current: scrollEl },
      overlayContainerRef: { current: overlayEl },
      ...overrides,
    };
  }

  async function renderSummary(
    scrollEl: HTMLDivElement,
    overrides: Partial<SummaryProps> = {},
    options: { strictMode?: boolean } = {},
  ): Promise<{
    container: HTMLDivElement;
    overlayEl: HTMLDivElement;
    root: Root;
    rerender: (next: Partial<SummaryProps>) => Promise<void>;
  }> {
    const container = document.createElement("div");
    // The expanded summary is portaled into a SEPARATE "message area" node, as in
    // the real layout — it is not a child of the bar's own container.
    const overlayEl = document.createElement("div");
    document.body.appendChild(container);
    document.body.appendChild(overlayEl);
    const root = createRoot(container);
    let props = summaryProps(scrollEl, overlayEl, overrides);
    const renderTree = (nextProps: SummaryProps) => {
      const summary = createElement(ChatSummary, nextProps);
      return options.strictMode ? createElement(StrictMode, null, summary) : summary;
    };
    await act(async () => {
      root.render(renderTree(props));
    });
    return {
      container,
      overlayEl,
      root,
      rerender: async (next: Partial<SummaryProps>) => {
        props = { ...props, ...next };
        await act(async () => {
          root.render(renderTree(props));
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
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });

    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Collapse current state"]')?.textContent,
    ).toContain("Current state");
    // Expanded body is the floating card, portaled into the message-area node.
    expect(overlayEl.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("renders a current-state headline and quieter supporting copy across the full card width", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      description:
        "The **current result** is ready for readers.\n\nSupporting context is secondary.\n\n**Next:** Observe usage.",
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });

    const card = overlayEl.querySelector<HTMLElement>('section[aria-label="Current state"]');
    const summaryDocument = card?.querySelector<HTMLElement>('[data-summary-part="document"]');
    const lead = summaryDocument?.querySelector<HTMLElement>('[data-summary-part="lead"]');
    const paragraphs = summaryDocument?.querySelectorAll("p");
    expect(summaryDocument?.dataset.summaryLayout).toBe("lead");
    // Blank-line lead must be a child span — never the <p> that receives [&_p]:text-body.
    expect(lead?.tagName).toBe("SPAN");
    expect(lead?.parentElement?.tagName).toBe("P");
    expect(paragraphs?.[0]?.getAttribute("data-summary-part")).toBeNull();
    expect(summaryDocument?.querySelectorAll('[data-summary-part="lead"]')).toHaveLength(1);
    expect(lead?.textContent).toContain("The current result is ready for readers.");
    expect(lead?.className).toContain("text-subtitle");
    expect(lead?.style.fontSize).toBe("var(--text-subtitle)");
    // The lead reads as the lead through size and colour only — never weight. A
    // majority of descriptions are a single line, where a bolded lead is the
    // whole summary and the emphasis carries no information.
    expect(lead?.style.fontWeight).toBe("var(--text-body--font-weight)");
    // Spacing below the lead is CSS-driven so it can collapse when the lead is
    // the last thing in the summary; an inline margin could not.
    expect(lead?.style.marginBottom).toBe("");
    // Authored emphasis is untouched — only the promotion styling drops weight.
    expect(lead?.querySelector("strong")?.textContent).toBe("current result");
    expect(paragraphs?.[1]?.textContent).toContain("Supporting context is secondary.");
    expect(paragraphs?.[2]?.textContent).toContain("Next: Observe usage.");
    expect(summaryDocument?.style.color).toBe("var(--fg-2)");
    // The card spans its overlay container edge to edge, so it lines up with the
    // chat header and the collapsed bar above it instead of carrying a measure of
    // its own. Verified as real geometry in the browser; asserted here as the
    // stretch that produces it.
    // Parsed rather than compared to a literal: the design-token guard forbids
    // raw pixel strings anywhere under `src`, tests included.
    expect(Number.parseFloat(card?.style.left ?? "")).toBe(0);
    expect(Number.parseFloat(card?.style.right ?? "")).toBe(0);
    expect(card?.style.maxWidth).toBe("");
    expect(card?.style.width).toBe("");
    expect(card?.getAttribute("style")).not.toContain("chat-summary-readable-rail");
    // No nested wrapper between the card and its rendered document.
    expect(card?.firstElementChild?.getAttribute("data-summary-part")).toBe("document");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("promotes only the first physical line when the writing contract uses soft breaks", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      description: [
        "Chat Summary V1 已上线，后续摘要会优先展示用户可行动的当前状态。",
        "旧摘要会在下一次实质进展时重写；用户无需关注 PR、CI 或版本号。",
        "**下一步**：观察真实 Chat 切换反馈，再决定是否继续调整展示。",
      ].join("\n"),
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });

    const summaryDocument = overlayEl.querySelector<HTMLElement>('[data-summary-part="document"]');
    const lead = summaryDocument?.querySelector<HTMLElement>('[data-summary-part="lead"]');
    const paragraphs = summaryDocument?.querySelectorAll("p");
    expect(summaryDocument?.dataset.summaryLayout).toBe("lead");
    // Soft breaks stay in one paragraph under remark-breaks.
    expect(paragraphs?.length).toBe(1);
    expect(lead?.tagName).toBe("SPAN");
    expect(paragraphs?.[0]?.getAttribute("data-summary-part")).toBeNull();
    expect(lead?.textContent).toBe("Chat Summary V1 已上线，后续摘要会优先展示用户可行动的当前状态。");
    expect(lead?.className).toContain("text-subtitle");
    expect(lead?.style.fontSize).toBe("var(--text-subtitle)");
    // Supporting soft-break lines remain in the same <p> but outside the lead.
    expect(paragraphs?.[0]?.textContent).toContain("旧摘要会在下一次实质进展时重写");
    expect(paragraphs?.[0]?.textContent).toContain("下一步");
    expect(lead?.textContent).not.toContain("旧摘要会在下一次实质进展时重写");
    expect(lead?.textContent).not.toContain("下一步");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("keeps a unique lead under StrictMode for soft-break writing-contract copy", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(
      scrollEl,
      {
        description: ["首行是唯一 headline。", "第二行保持普通正文。", "第三行也是普通正文。"].join("\n"),
        descriptionUpdatedAt: unreadVersionAt,
        lastReadAt: readRecentlyAt,
      },
      { strictMode: true },
    );

    const leads = overlayEl.querySelectorAll('[data-summary-part="lead"]');
    expect(leads).toHaveLength(1);
    expect(leads[0]?.tagName).toBe("SPAN");
    expect(leads[0]?.textContent).toBe("首行是唯一 headline。");
    expect(leads[0]?.textContent).not.toContain("第二行");
    expect(overlayEl.querySelector("p")?.getAttribute("data-summary-part")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  // Most descriptions are a single physical line. There the lead IS the whole
  // summary, so it must not be emphasised against itself and must not reserve
  // separation for supporting copy that does not exist.
  it("does not emphasise or pad a single-line summary against itself", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      description: "正在核验成员规模、安装完成情况与实际使用情况，口径按 T+1 截止。",
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });

    const summaryDocument = overlayEl.querySelector<HTMLElement>('[data-summary-part="document"]');
    const lead = summaryDocument?.querySelector<HTMLElement>('[data-summary-part="lead"]');
    expect(summaryDocument?.querySelectorAll("p")).toHaveLength(1);
    expect(lead?.textContent).toBe("正在核验成员规模、安装完成情况与实际使用情况，口径按 T+1 截止。");
    expect(lead?.style.fontWeight).toBe("var(--text-body--font-weight)");
    // The lead is its paragraph's last child here, which is what lets the CSS
    // `:last-child` rule collapse the separation below it.
    expect(lead?.nextSibling).toBeNull();
    expect(lead?.style.marginBottom).toBe("");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("keeps reference links connected while styling the first paragraph", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      description:
        "The current result links to [details][result].\n\nSupporting context.\n\n[result]: https://example.com/result",
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });

    const link = overlayEl.querySelector<HTMLAnchorElement>('[data-summary-layout="lead"] a');
    expect(link?.textContent).toBe("details");
    expect(link?.href).toBe("https://example.com/result");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("keeps indented code in the faithful block-first layout", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      description: "    const result = 'ready';\n\nSupporting context.",
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });

    const summaryDocument = overlayEl.querySelector<HTMLElement>('[data-summary-part="document"]');
    expect(summaryDocument?.dataset.summaryLayout).toBe("faithful");
    expect(summaryDocument?.querySelector("pre code")?.textContent).toContain("const result = 'ready';");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("can keep an unread summary collapsed on narrow mobile entry", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
      autoExpandUnread: false,
    });

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();
    expect(overlayEl.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("Updated");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("can ignore a desktop-expanded manual preference on mobile entry", async () => {
    localStorage.clear();
    localStorage.setItem("first-tree:chat-summary-expanded:v1:chat-1", "1");
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
      autoExpandUnread: false,
      restoreManualExpansion: false,
    });

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();
    expect(overlayEl.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("Updated");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("does not auto-expand the same unread summary version after the user manually collapses it", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const unreadProps = {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    };
    const first = await renderSummary(scrollEl, unreadProps);
    const collapseButton = first.container.querySelector<HTMLButtonElement>(
      'button[aria-label="Collapse current state"]',
    );
    if (!collapseButton) throw new Error("summary collapse button missing");
    await act(async () => {
      collapseButton.click();
    });
    await act(async () => first.root.unmount());
    first.container.remove();
    first.overlayEl.remove();

    const second = await renderSummary(scrollEl, unreadProps);
    expect(
      second.container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]'),
    ).not.toBeNull();
    expect(second.overlayEl.querySelector("strong")).toBeNull();
    expect(second.container.textContent).toContain("Updated");

    await act(async () => second.root.unmount());
    second.container.remove();
    second.overlayEl.remove();
  });

  it("keeps the current mounted chat collapsed when a newer unread summary version arrives", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root, rerender } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: readRecentlyAt,
      lastReadAt: unreadVersionAt,
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();

    await rerender({
      descriptionUpdatedAt: newerUnreadVersionAt,
      lastReadAt: unreadVersionAt,
    });

    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();
    expect(overlayEl.querySelector("strong")).toBeNull();
    expect(container.textContent).toContain("Updated");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("keeps a manual expand open when the stream was already scrolled", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 120;
    const { container, overlayEl, root } = await renderSummary(scrollEl);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]');
    if (!button) throw new Error("summary button missing");

    await act(async () => {
      button.click();
    });
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Collapse current state"]')?.textContent,
    ).toContain("Current state");
    expect(overlayEl.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => {
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(overlayEl.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("still collapses after a fresh downward scroll from a manual expand point", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 120;
    const { container, overlayEl, root } = await renderSummary(scrollEl);
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]');
    if (!button) throw new Error("summary button missing");

    await act(async () => {
      button.click();
    });
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Collapse current state"]')?.textContent,
    ).toContain("Current state");
    expect(overlayEl.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => {
      scrollEl.scrollTop = 170;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(overlayEl.querySelector("strong")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("does not auto-expand a sticky-collapsed summary when scrolling back to the top", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    // Auto-expanded on entry (unread): the floating card is up.
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Collapse current state"]')).not.toBeNull();
    expect(overlayEl.querySelector("strong")).not.toBeNull();

    // Scroll down → sticky-collapse folds it to the bar.
    await act(async () => {
      scrollEl.scrollTop = 120;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();
    expect(overlayEl.querySelector("strong")).toBeNull();

    // Scroll back to the top → must NOT re-expand (regression guard for PR 1252).
    await act(async () => {
      scrollEl.scrollTop = 0;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();
    expect(overlayEl.querySelector("strong")).toBeNull();

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("expands on the first click from the sticky-collapsed bar", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl);
    const initialButton = container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]');
    if (!initialButton) throw new Error("summary button missing");

    await act(async () => {
      initialButton.click();
    });
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-label="Collapse current state"]')?.textContent,
    ).toContain("Current state");
    expect(overlayEl.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => {
      scrollEl.scrollTop = 120;
      scrollEl.dispatchEvent(new Event("scroll"));
    });
    expect(overlayEl.querySelector("strong")).toBeNull();

    const stickyButton = container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]');
    if (!stickyButton) throw new Error("sticky summary button missing");
    await act(async () => {
      stickyButton.click();
    });
    expect(overlayEl.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("portals the expanded body as a floating card over the message area (no in-flow reflow)", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    // Bar stays in the component's own container; the body is NOT in flow there
    // (so it never pushes the message stream down).
    expect(container.querySelector("strong")).toBeNull();
    // It lives in the message-area node as an absolute, self-scrolling card.
    const card = overlayEl.querySelector<HTMLElement>('section[aria-label="Current state"]');
    expect(card).not.toBeNull();
    expect(card?.style.position).toBe("absolute");
    expect(card?.querySelector("strong")?.textContent).toBe("DescBody");

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("forwards a wheel over the bar to the message stream, but leaves horizontal pans alone", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    scrollEl.scrollTop = 0;
    const { container, overlayEl, root } = await renderSummary(scrollEl);
    const bar = container.firstElementChild as HTMLElement | null;
    if (!bar) throw new Error("summary bar missing");

    // A vertical wheel over the thin bar (no scrollable ancestor) drives the stream.
    await act(async () => {
      bar.dispatchEvent(wheelEvent(90));
    });
    expect(scrollEl.scrollTop).toBe(90);

    // A horizontal-dominant gesture is left to the browser: nothing scrolls and
    // the event is not consumed.
    const ev = wheelEvent(6, 120);
    await act(async () => {
      bar.dispatchEvent(ev);
    });
    expect(scrollEl.scrollTop).toBe(90);
    expect(ev.defaultPrevented).toBe(false);

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });

  it("dismisses the floating card on Escape", async () => {
    localStorage.clear();
    const scrollEl = document.createElement("div");
    const { container, overlayEl, root } = await renderSummary(scrollEl, {
      descriptionUpdatedAt: unreadVersionAt,
      lastReadAt: readRecentlyAt,
    });
    expect(overlayEl.querySelector("strong")).not.toBeNull();

    // Non-modal overlay: Escape collapses it back to the bar (page stays live).
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(overlayEl.querySelector("strong")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Expand current state"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
    overlayEl.remove();
  });
});
