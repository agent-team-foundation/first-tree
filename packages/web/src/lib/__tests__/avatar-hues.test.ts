// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { AVATAR_HUE_COUNT, avatarHueColor, fgOnVividColor } from "../avatar-hues.js";

describe("avatar-hues", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("exposes the palette length and resolves CSS colors via the DOM", () => {
    expect(AVATAR_HUE_COUNT).toBe(8);
    // Without tokens set, the browser still returns a concrete color string
    // (often the inherited default) or falls back to the expression.
    const hue = avatarHueColor(0);
    expect(typeof hue).toBe("string");
    expect(hue.length).toBeGreaterThan(0);
    const onVivid = fgOnVividColor();
    expect(typeof onVivid).toBe("string");
    expect(onVivid.length).toBeGreaterThan(0);
  });
});
