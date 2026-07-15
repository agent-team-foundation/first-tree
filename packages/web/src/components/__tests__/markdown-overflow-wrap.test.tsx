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

/**
 * Regression: a chat message carrying one unbreakable run (a bare login URL
 * with two embedded JWTs, ~620 chars) widened the chat timeline and put a
 * horizontal scrollbar on the whole message stream. The prose wrapper must
 * carry `break-words` (overflow-wrap: break-word) so such runs wrap instead
 * of overflowing. happy-dom does no layout, so the class on the wrapper is
 * the testable contract.
 */
describe("Markdown long-token wrapping", () => {
  it("keeps break-words on the prose wrapper", () => {
    renderMarkdown(`http://localhost:5179/auth/github/complete#access=${"eyJx".repeat(150)}`);
    const wrapper = container.querySelector(".prose");
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain("break-words");
  });

  it("renders headings and bounds fenced code to its own horizontal scroller", () => {
    renderMarkdown(
      `## Verification\n\n\`\`\`sh\nfirst-tree-staging tree verify --tree-path /${"long-segment".repeat(20)}\n\`\`\``,
    );
    const wrapper = container.querySelector(".prose");
    expect(container.querySelector("h2")?.textContent).toBe("Verification");
    expect(container.textContent).not.toContain("## Verification");
    expect(wrapper?.className).toContain("prose-pre:max-w-full");
    expect(wrapper?.className).toContain("prose-pre:overflow-x-auto");
    expect(container.querySelector("pre code")?.textContent).toContain("first-tree-staging tree verify");
  });
});
