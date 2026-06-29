import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const agentSetupRoot = resolve(here, "..");

describe("agent setup import boundary", () => {
  it("stays reusable outside formal onboarding", () => {
    const files = ["use-agent-creation.ts", "use-computer-connection.ts"];

    for (const file of files) {
      const source = readFileSync(resolve(agentSetupRoot, file), "utf8");

      expect(source, file).not.toContain("pages/onboarding");
      expect(source, file).not.toContain("onboarding-flow");
      expect(source, file).not.toContain("onboarding-flags");
      expect(source, file).not.toContain("onboarding-events");
      expect(source, file).not.toContain("onboarding:");
    }
  });
});
