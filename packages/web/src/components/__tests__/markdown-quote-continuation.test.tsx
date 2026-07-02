// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Markdown } from "../ui/markdown.js";

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

function renderMarkdown(markdown: string): void {
  act(() => root.render((<Markdown>{markdown}</Markdown>) as ReactElement));
}

describe("Markdown quote continuation", () => {
  it("keeps the line after a blockquote outside the quote without requiring a blank line", () => {
    renderMarkdown("> quoted\nblah blah");

    const blockquote = container.querySelector("blockquote");
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent?.trim()).toBe("quoted");

    const paragraphs = [...container.querySelectorAll("p")].map((paragraph) => paragraph.textContent);
    expect(paragraphs).toEqual(["quoted", "blah blah"]);
  });

  it("supports a single-pipe chat quote shorthand without treating the following line as quoted", () => {
    renderMarkdown("| quoted\nblah blah");

    const blockquote = container.querySelector("blockquote");
    expect(blockquote).not.toBeNull();
    expect(blockquote?.textContent?.trim()).toBe("quoted");

    const paragraphs = [...container.querySelectorAll("p")].map((paragraph) => paragraph.textContent);
    expect(paragraphs).toEqual(["quoted", "blah blah"]);
  });

  it("preserves normal GFM tables that start with pipe characters", () => {
    renderMarkdown("| Col A | Col B |\n| --- | --- |\n| A | B |");

    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.textContent).toContain("Col A");
    expect(container.textContent).toContain("Col B");
  });

  it("leaves quote-like lines inside fenced code blocks untouched", () => {
    renderMarkdown("```\n> quoted\n| quoted\n```\noutside");

    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("> quoted\n| quoted");
    expect(container.textContent).toContain("outside");
  });

  it("does not treat pipe-prefixed indented code as quote shorthand", () => {
    renderMarkdown("    | quoted\n    outside");

    expect(container.querySelector("blockquote")).toBeNull();
    expect(container.querySelector("pre")).not.toBeNull();
    const codeText = container.querySelector("pre")?.textContent ?? "";
    expect(codeText).toContain("| quoted\noutside");
    expect(codeText).not.toContain("| quoted\n\noutside");
  });
});
