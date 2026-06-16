import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "../avatar.js";
import { Identicon } from "../identicon.js";

/**
 * Pin the avatar fallback contract after the identicon migration: an image
 * src still renders a circular <img>; otherwise the avatar is a labelled
 * circular identicon — a hue-filled tile with near-white blocks (currentColor).
 * A regression here changes how every seeded avatar renders.
 */

describe("Identicon — SVG block tile", () => {
  it("renders near-white rects (currentColor) on a hue-filled circular tile", () => {
    const html = renderToStaticMarkup(<Identicon seed="agent-7f3a91" size={40} color="var(--avatar-hue-2)" />);
    expect(html).toContain("<svg");
    expect(html).toContain("<rect");
    expect(html).toContain('fill="currentColor"');
    // inverted palette: hue fills the tile, blocks are --fg-on-vivid via currentColor
    expect(html).toContain("background:var(--avatar-hue-2)");
    expect(html).toContain("color:var(--fg-on-vivid)");
    // circular, like every other avatar surface
    expect(html).toContain("border-radius:50%");
  });

  it("is presentational by default and labelled when a label is given", () => {
    expect(renderToStaticMarkup(<Identicon seed="x" size={24} color="red" />)).toContain('aria-hidden="true"');
    const labelled = renderToStaticMarkup(<Identicon seed="x" size={24} color="red" label="Alice" />);
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Alice"');
  });

  it("is deterministic for a seed (stable markup across renders)", () => {
    const a = renderToStaticMarkup(<Identicon seed="bob" size={28} color="blue" />);
    const b = renderToStaticMarkup(<Identicon seed="bob" size={28} color="blue" />);
    expect(a).toBe(b);
  });
});

describe("Avatar — image vs identicon fallback", () => {
  it("renders a circular image when src is present", () => {
    const html = renderToStaticMarkup(<Avatar src="https://example.com/a.png" name="Alice" seed="uuid-1" />);
    expect(html).toContain("<img");
    expect(html).toContain("border-radius:50%");
    expect(html).not.toContain("<svg");
  });

  it("falls back to a labelled identicon when no src", () => {
    const html = renderToStaticMarkup(<Avatar name="Alice" seed="uuid-1" />);
    expect(html).toContain("<svg");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Alice"');
    expect(html).not.toContain("<img");
  });

  it("seeds the identicon from name when no seed is provided", () => {
    const bySeed = renderToStaticMarkup(<Avatar name="Alice" seed="Alice" />);
    const byName = renderToStaticMarkup(<Avatar name="Alice" />);
    expect(byName).toBe(bySeed);
  });
});
