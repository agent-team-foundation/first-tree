import { describe, expect, it } from "vitest";
import { KIMI_CODE_SDK_VERSION, probeKimiCodeCapability } from "../runtime/capabilities/kimi-code.js";

describe("probeKimiCodeCapability", () => {
  it("reports the exact bundled SDK without launching or checking auth", async () => {
    expect(await probeKimiCodeCapability()).toMatchObject({
      state: "ok",
      available: true,
      sdkVersion: KIMI_CODE_SDK_VERSION,
      runtimeSource: "bundled",
      runtimePath: null,
    });
    expect(KIMI_CODE_SDK_VERSION).toBe("0.26.0-botiverse.2");
  });
});
