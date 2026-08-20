import { describe, expect, it } from "vitest";
import {
  runtimeInstallResultFrameSchema,
  runtimeInstallStartCommandSchema,
  runtimeInstallStartRequestSchema,
} from "../schemas/runtime-install.js";

describe("runtime install schemas", () => {
  it.each(["codex", "claude-code"] as const)("accepts the fixed %s provider", (provider) => {
    expect(runtimeInstallStartRequestSchema.parse({ provider })).toEqual({ provider });
    expect(
      runtimeInstallStartCommandSchema.parse({
        type: "runtime-install:start",
        provider,
        ref: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).toMatchObject({ provider });
  });

  it.each([
    "cursor",
    "kimi-code",
    "codex@latest",
    "npm install -g anything",
  ])("rejects non-allowlisted provider input %s", (provider) => {
    expect(runtimeInstallStartRequestSchema.safeParse({ provider }).success).toBe(false);
  });

  it("bounds failure output and rejects caller-controlled extra fields", () => {
    expect(
      runtimeInstallResultFrameSchema.safeParse({
        type: "runtime-install:result",
        provider: "codex",
        ref: "123e4567-e89b-42d3-a456-426614174000",
        status: "failed",
        reason: "x".repeat(501),
        reasonCode: "npm_failed",
        retryable: true,
      }).success,
    ).toBe(false);
    expect(runtimeInstallStartRequestSchema.safeParse({ provider: "codex", command: "rm -rf /" }).success).toBe(false);
  });
});
