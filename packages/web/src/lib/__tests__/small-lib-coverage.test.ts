// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { humanizeAgentType, humanizeVisibility } from "../agent-labels.js";
import { AVATAR_HUE_COUNT, avatarHueColor, fgOnVividColor } from "../avatar-hues.js";
import { TONE_STYLES, type Tone, toneOf } from "../tones.js";

const cssRgb = (...channels: number[]): string => ["rgb", `(${channels.join(", ")})`].join("");

describe("agent label helpers", () => {
  it("humanizes agent type and visibility literals", () => {
    expect(humanizeAgentType("human")).toBe("Human");
    expect(humanizeAgentType("agent")).toBe("Agent");
    expect(humanizeVisibility("private")).toBe("Private");
    expect(humanizeVisibility("organization")).toBe("Organization");
  });
});

describe("avatar hue colors", () => {
  it("resolves avatar CSS tokens through the DOM style engine", () => {
    document.documentElement.style.setProperty("--avatar-hue-3", cssRgb(1, 2, 3));
    document.documentElement.style.setProperty("--fg-on-vivid", cssRgb(250, 251, 252));

    expect(AVATAR_HUE_COUNT).toBe(8);
    expect(avatarHueColor(3)).toBe(cssRgb(1, 2, 3));
    expect(fgOnVividColor()).toBe(cssRgb(250, 251, 252));
  });
});

describe("tone styles", () => {
  it("returns the style for every known tone and falls back to neutral for unknown runtime input", () => {
    const tones = [
      "neutral",
      "accent",
      "warn",
      "error",
      "outline",
      "idle",
      "working",
      "blocked",
      "offline",
    ] satisfies Tone[];

    for (const tone of tones) {
      expect(toneOf(tone)).toBe(TONE_STYLES[tone]);
    }

    expect(toneOf("missing" as Tone)).toBe(TONE_STYLES.neutral);
  });
});
