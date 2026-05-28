import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("LoginPage dev links", () => {
  it("exposes a localhost-only dev shortcut that simulates completed onboarding", async () => {
    const source = await readFile(new URL("../login.tsx", import.meta.url), "utf8");

    expect(source).toContain("skipOnboarding=1");
    expect(source).toContain("Dev: skip onboarding");
  });
});
