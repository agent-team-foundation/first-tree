import { describe, expect, it } from "vitest";
import { buildMobileInstallUrl, readMobileInstallSource } from "../mobile-install.js";

describe("mobile install links", () => {
  it("builds an origin-local public URL with analytics source only", () => {
    expect(buildMobileInstallUrl("https://cloud.first-tree.ai", "start_chat")).toBe(
      "https://cloud.first-tree.ai/m/install?source=start_chat",
    );
    expect(buildMobileInstallUrl("https://self-hosted.example/base", "user_menu")).toBe(
      "https://self-hosted.example/m/install?source=user_menu",
    );
  });

  it("accepts only known attribution values", () => {
    expect(readMobileInstallSource("start_chat")).toBe("start_chat");
    expect(readMobileInstallSource("user_menu")).toBe("user_menu");
    expect(readMobileInstallSource("token-looking-value")).toBe("direct");
    expect(readMobileInstallSource(null)).toBe("direct");
  });
});
