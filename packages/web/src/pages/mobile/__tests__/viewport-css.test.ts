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
});
