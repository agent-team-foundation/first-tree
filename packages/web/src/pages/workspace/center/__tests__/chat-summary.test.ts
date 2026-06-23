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
  async function renderSummary(scrollEl: HTMLDivElement): Promise<{ container: HTMLDivElement; root: Root }> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(ChatSummary, {
          chatId: "chat-1",
          description: "Status: shipping **DescBody** soon.",
          descriptionUpdatedAt: null,
          lastReadAt: null,
          freshnessReady: true,
          scrollContainerRef: { current: scrollEl },
        }),
      );
    });
    return { container, root };
  }

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
});
