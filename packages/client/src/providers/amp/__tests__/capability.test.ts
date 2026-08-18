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
    const result = await probeAmpCapability({ findOnPath: () => null, env: {}, platform: "linux" });
    expect(result).toMatchObject({ state: "missing", available: false });
    expect(result.error).toContain("ampcode.com/install.sh");
    expect(result.error).toContain("amp login");
  });

  it("win32 fails closed before install detection (missing or present) with Job Object copy", async () => {
    // state `error` (not `missing`) keeps setup cards from rendering the
    // macOS/Linux installer for a runtime First Tree will always reject here.
    const findOnPath = vi.fn(() => "C:\\Users\\me\\AppData\\Roaming\\npm\\amp.exe");
    const result = await probeAmpCapability({
      findOnPath,
      env: { PATH: "C:\\Users\\me\\AppData\\Roaming\\npm" },
      platform: "win32",
    });

    expect(result).toMatchObject({
      state: "error",
      available: false,
    });
    expect(result.error).toContain("not supported on Windows");
    expect(result.error).toContain("Job Object");
    expect(findOnPath).not.toHaveBeenCalled();
  });

  it("win32 missing binary also fails closed without the install.sh invite", async () => {
    const findOnPath = vi.fn(() => null);
    const result = await probeAmpCapability({ findOnPath, env: {}, platform: "win32" });
    expect(result).toMatchObject({ state: "error", available: false });
    expect(result.error).toContain("not supported on Windows");
    expect(result.error).not.toContain("ampcode.com/install.sh");
    expect(findOnPath).not.toHaveBeenCalled();
  });
});
