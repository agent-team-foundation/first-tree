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
 * Issue 831 regression: a tree-build agent writes its worktree path into chat
 * as a markdown link. react-markdown keeps the schemeless filesystem path as
 * the anchor href; clicking it resolves against the cloud origin and 404s. The
 * `Markdown` `a` override must drop the dead anchor and keep the text.
 */
describe("Markdown link guard (issue 831)", () => {
  it("renders a local worktree-path link as plain text, not an anchor", () => {
    const worktree = "/Users/gandy/.first-tree/data/workspaces/gandy-s-assistant/worktrees/build-tree";
    renderMarkdown(`Created at [${worktree}](${worktree})`);
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain(worktree);
  });

  it("renders a labelled worktree-path link without a 404 anchor", () => {
    renderMarkdown("see [worktree](/Users/u/.first-tree/worktrees/x) for output");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("worktree");
  });

  it("still renders real external web links as anchors", () => {
    renderMarkdown("docs at [the site](https://cloud.first-tree.ai/docs)");
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("href")).toBe("https://cloud.first-tree.ai/docs");
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("still renders mailto links as anchors", () => {
    renderMarkdown("[mail](mailto:hi@first-tree.ai)");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("mailto:hi@first-tree.ai");
  });
});
