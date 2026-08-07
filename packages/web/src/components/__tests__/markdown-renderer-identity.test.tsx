// @vitest-environment happy-dom

import { act, type ReactElement, useState } from "react";
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

/**
 * Parent re-renders of Markdown must keep the same DOM anchor node when the
 * markdown source is unchanged. Inline default `components.a` factories used
 * to remount the link and drop focus into surrounding surfaces.
 */
describe("Markdown default renderer identity", () => {
  it("keeps DOM identity and focus on an unchanged link across parent re-renders", async () => {
    let bump: (() => void) | undefined;

    function Harness() {
      const [, setTick] = useState(0);
      bump = () => setTick((value) => value + 1);
      return <Markdown>See [notes](https://example.com/notes) for detail.</Markdown>;
    }

    act(() => {
      root.render((<Harness />) as ReactElement);
    });

    const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/notes"]');
    if (!link) throw new Error("Expected Markdown link");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    link.focus();
    expect(document.activeElement).toBe(link);

    act(() => {
      bump?.();
    });
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        });
      });
    }

    const after = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/notes"]');
    expect(after).toBe(link);
    expect(document.activeElement).toBe(link);
  });

  it("still lets caller-supplied components override the defaults", () => {
    act(() => {
      root.render(
        (
          <Markdown
            components={{
              a: ({ href, children }) => (
                <a href={href} data-custom-anchor="true">
                  {children}
                </a>
              ),
            }}
          >
            [custom](https://example.com/custom)
          </Markdown>
        ) as ReactElement,
      );
    });

    const link = container.querySelector("a");
    expect(link?.getAttribute("data-custom-anchor")).toBe("true");
    expect(link?.getAttribute("href")).toBe("https://example.com/custom");
    // Caller override wins; default target/rel are not forced on.
    expect(link?.getAttribute("target")).toBeNull();
  });
});
