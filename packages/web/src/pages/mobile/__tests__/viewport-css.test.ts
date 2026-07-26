import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexCss = readFileSync(new URL("../../../index.css", import.meta.url), "utf8");

describe("mobile shell viewport CSS", () => {
  it("overrides dynamic height with 100vh only for standalone WebKit", () => {
    const dynamicViewportRule = indexCss.indexOf("@supports (height: 100dvh)");
    const webkitRule = indexCss.indexOf("@supports (-webkit-touch-callout: none)");
    const standaloneRule = indexCss.indexOf("@media (display-mode: standalone)", webkitRule);
    const standaloneBlock = indexCss.slice(standaloneRule, standaloneRule + 140);

    expect(dynamicViewportRule).toBeGreaterThan(-1);
    expect(webkitRule).toBeGreaterThan(dynamicViewportRule);
    expect(standaloneRule).toBeGreaterThan(webkitRule);
    expect(standaloneBlock).toContain(".h-dvh-screen");
    expect(standaloneBlock).toContain("height: 100vh");
  });

  it("reserves the mobile timeline-jump footprint beside current output", () => {
    const narrationClearance = indexCss.lastIndexOf(".compose-status-narration-with-jump > :first-child");
    const mobileRule = indexCss.lastIndexOf("@media (max-width: 47.999rem)", narrationClearance);
    const jumpRule = indexCss.indexOf(".compose-status-jump {", narrationClearance);
    const clearanceBlock = indexCss.slice(narrationClearance, jumpRule);
    const jumpBlock = indexCss.slice(jumpRule, jumpRule + 140);

    expect(mobileRule).toBeGreaterThan(-1);
    expect(narrationClearance).toBeGreaterThan(mobileRule);
    expect(clearanceBlock).toContain("padding-right: var(--sp-11)");
    expect(jumpBlock).toContain("width: var(--sp-11)");
    expect(jumpBlock).toContain("height: var(--sp-11)");
  });
});
