import { describe, expect, it, vi } from "vitest";
import { probeDeepseekCapability } from "../capability.js";

describe("DeepSeek install-only capability", () => {
  it("reports the bundled binary without launching or inspecting auth", async () => {
    const resolveRuntime = vi.fn(() => ({
      ok: true as const,
      binary: "/app/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js",
      cordisPath: "/app/dist/runtime-assets/deepseek-harness-cordis.yml",
      moduleBaseUrl: "file:///app/node_modules/@deepseek-ai/dsh-sdk-jsonrpc-demo/lib/packaged-bin.js",
    }));
    await expect(probeDeepseekCapability({ resolveRuntime, env: {} })).resolves.toMatchObject({
      state: "ok",
      available: true,
      runtimeSource: "bundled",
    });
    expect(resolveRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports a missing bundled runtime with actionable setup copy", async () => {
    const result = await probeDeepseekCapability({
      resolveRuntime: () => ({ ok: false, error: "missing", transient: false }),
      env: {},
      platform: "linux",
    });
    expect(result).toMatchObject({ state: "missing", available: false });
    expect(result.error).toContain("dsh-sdk-jsonrpc-demo");
    expect(result.error).toContain("DEEPSEEK_API_KEY");
  });

  it("win32 fails closed before install detection with Job Object copy", async () => {
    const resolveRuntime = vi.fn(() => ({
      ok: true as const,
      binary: "C:\\app\\dsh-jsonrpc-agent.exe",
      cordisPath: "C:\\app\\cordis.yml",
      moduleBaseUrl: "file:///C:/app/dsh-jsonrpc-agent.exe",
    }));
    const result = await probeDeepseekCapability({ resolveRuntime, env: {}, platform: "win32" });
    expect(result).toMatchObject({ state: "error", available: false });
    expect(result.error).toContain("not supported on Windows");
    expect(result.error).toContain("Job Object");
    expect(resolveRuntime).not.toHaveBeenCalled();
  });
});
