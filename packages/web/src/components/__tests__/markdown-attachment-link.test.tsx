// @vitest-environment happy-dom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Components } from "react-markdown";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attachmentIdFromHref } from "../../lib/doc-preview-links.js";
import { isNavigableWebHref } from "../../lib/safe-href.js";
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

/**
 * Mirror of chat-view's `a` override at the seam relevant to this regression:
 * an `attachment:<uuid>` href must reach the override intact so it renders as a
 * live anchor (the click handler then opens the drawer). Anything that is not a
 * doc-preview attachment nor a navigable web URL is dropped to plain text.
 */
const attachmentLinkComponents: Components = {
  a({ href, children, ...props }) {
    const attachmentId = typeof href === "string" ? attachmentIdFromHref(href) : null;
    if (!attachmentId && !isNavigableWebHref(href)) {
      return <>{children}</>;
    }
    return (
      <a {...props} href={href} data-attachment-id={attachmentId ?? undefined}>
        {children}
      </a>
    );
  },
};

function renderMarkdown(markdown: string): void {
  act(() => root.render((<Markdown components={attachmentLinkComponents}>{markdown}</Markdown>) as ReactElement));
}

/**
 * Render-seam regression: react-markdown's `defaultUrlTransform` strips the
 * unknown `attachment:` scheme to `href=""` BEFORE the `a` component override
 * runs. Without the `urlTransform` passthrough in `markdown.tsx`, the override
 * sees an empty href, `attachmentIdFromHref` returns null, and the doc-preview
 * link renders as dead plain text. This test exercises the real `<Markdown>`
 * wrapper (not a helper / deep-link shortcut), so it fails without that fix.
 */
describe("Markdown attachment link render seam", () => {
  const uuid = "11111111-2222-4333-8444-555555555555";

  it("preserves an attachment:<uuid> href through the real Markdown wrapper", () => {
    renderMarkdown(`See [the doc](attachment:${uuid})`);
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    // The load-bearing assertion: NOT stripped to "".
    expect(anchor?.getAttribute("href")).toBe(`attachment:${uuid}`);
    expect(anchor?.getAttribute("data-attachment-id")).toBe(uuid);
  });

  it("still strips unknown/unsafe schemes via the default transform", () => {
    renderMarkdown("[evil](javascript:alert(1))");
    // The default transform neutralizes the href; the override then drops the
    // non-navigable anchor to plain text.
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("evil");
  });

  it("still renders normal external links as anchors", () => {
    renderMarkdown("[site](https://cloud.first-tree.ai/docs)");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://cloud.first-tree.ai/docs");
  });
});
