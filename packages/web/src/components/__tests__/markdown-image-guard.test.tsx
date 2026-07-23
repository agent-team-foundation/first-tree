// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Markdown, type MarkdownProps } from "../ui/markdown.js";

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

function renderMarkdown(markdown: string, rehypePlugins?: MarkdownProps["rehypePlugins"]): void {
  act(() => root.render((<Markdown rehypePlugins={rehypePlugins}>{markdown}</Markdown>) as ReactElement));
}

describe("Markdown image guard", () => {
  it("turns a standalone trap image into alt text and an explicit safe link without a resource node", () => {
    const trap = "https://trap.invalid/pixel.png?message=1541";
    renderMarkdown(`Before ![tracking pixel](${trap}) after`);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("tracking pixel (View image)");
    const anchor = container.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe(trap);
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  it("keeps a linked image as alt text inside the sanitized outer link without nesting anchors", () => {
    const imageSource = "https://trap.invalid/linked.png";
    const destination = "https://cloud.first-tree.ai/docs";
    renderMarkdown(`[![security diagram](${imageSource})](${destination})`);

    expect(container.querySelector("img")).toBeNull();
    const anchors = container.querySelectorAll("a");
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("href")).toBe(destination);
    expect(anchors[0]?.textContent).toBe("security diagram");
    expect(anchors[0]?.querySelector("a")).toBeNull();
  });

  it("renders an unsafe image source as inert alt text with no link", () => {
    renderMarkdown("![do not run](javascript:alert(1))");

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("do not run");
  });

  it("applies the same non-fetching behavior to reference-style images", () => {
    const source = "https://trap.invalid/reference.png";
    renderMarkdown(`![reference preview][preview]\n\n[preview]: ${source}`);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("reference preview (View image)");
    expect(container.querySelector("a")?.getAttribute("href")).toBe(source);
  });

  it("runs after caller-provided rehype plugins", () => {
    type TestRoot = { type: "root"; children: TestNode[] };
    type TestNode = {
      type: string;
      tagName?: string;
      properties?: Record<string, unknown>;
      children?: TestNode[];
      value?: string;
    };
    const injectImage = () => (tree: TestRoot) => {
      tree.children.push({
        type: "element",
        tagName: "img",
        properties: { alt: "caller image", src: "https://trap.invalid/caller.png" },
        children: [],
      });
    };

    renderMarkdown("Body", [injectImage]);

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("caller image (View image)");
  });
});
