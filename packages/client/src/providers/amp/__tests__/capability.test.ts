import { describe, expect, it, vi } from "vitest";
import { probeAmpCapability } from "../capability.js";

describe("Amp install-only capability", () => {
  it("reports the exact path without launching or inspecting auth", async () => {
    const findOnPath = vi.fn(() => "/usr/local/bin/amp");
    await expect(probeAmpCapability({ findOnPath, env: { PATH: "/usr/local/bin" } })).resolves.toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "path",
      runtimePath: "/usr/local/bin/amp",
    });
    expect(findOnPath).toHaveBeenCalledTimes(1);
  });

  it("reports a missing external runtime with actionable setup copy", async () => {
    const result = await probeAmpCapability({ findOnPath: () => null, env: {} });
    expect(result).toMatchObject({ state: "missing", available: false });
    expect(result.error).toContain("ampcode.com/install.sh");
    expect(result.error).toContain("amp login");
  });

  it("does not advertise a resolved Windows binary that the default supervisor rejects", async () => {
    const findOnPath = vi.fn(() => "C:\\Users\\me\\AppData\\Roaming\\npm\\amp.exe");
    const result = await probeAmpCapability({
      findOnPath,
      env: { PATH: "C:\\Users\\me\\AppData\\Roaming\\npm" },
      platform: "win32",
    });

    expect(result).toMatchObject({
      state: "error",
      available: false,
      runtimeSource: "path",
      runtimePath: "C:\\Users\\me\\AppData\\Roaming\\npm\\amp.exe",
    });
    expect(result.error).toContain("cannot run it on Windows");
    expect(findOnPath).toHaveBeenCalledTimes(1);
  });
});
