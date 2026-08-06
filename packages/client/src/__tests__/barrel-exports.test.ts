import { describe, expect, it } from "vitest";

describe("public barrel exports", { timeout: 30_000 }, () => {
  it("loads the package entrypoint exports", async () => {
    const api = await import("../index.js");

    expect(api.FirstTreeHubSDK).toBeDefined();
    expect(api.FirstTreeSDK).toBe(api.FirstTreeHubSDK);
    expect(api.ClientConnection).toBeDefined();
    expect(api.AgentSlot).toBeDefined();
    expect(api.AgentRuntime).toBeDefined();
    expect(api.cleanAgentWorkspaces).toBeDefined();
    expect(api).not.toHaveProperty("cleanAgentWorkspacesWithDeps");
    expect(api).not.toHaveProperty("SessionManager");
    expect(api).not.toHaveProperty("SessionRegistry");
    expect(api.createBuiltinHandlerRegistry).toBeDefined();
    expect(api.resolveAndLogClaudeExecutable).toBeDefined();
    expect(api).not.toHaveProperty("registerBuiltinHandlers");
    expect(api).not.toHaveProperty("registerHandler");
    expect(api).not.toHaveProperty("getHandlerFactory");
    expect(api).not.toHaveProperty("hasHandler");
    // S1d contracts entry is not a package public API / temporary subpath export.
    expect(api).not.toHaveProperty("contracts");
    const publicKeys = Object.keys(api).sort();
    expect(publicKeys).not.toContain("SessionManager");
    expect(publicKeys).not.toContain("SessionRegistry");
    expect(publicKeys).not.toContain("noopDeliveryToken");
    expect(publicKeys).not.toContain("requireDeliveryToken");
  });

  it("loads runtime barrel exports", async () => {
    const runtime = await import("../runtime/index.js");

    expect(runtime.AgentSlot).toBeDefined();
    expect(runtime.AgentRuntime).toBeDefined();
    expect(runtime.cleanAgentWorkspaces).toBeDefined();
    expect(runtime).not.toHaveProperty("cleanAgentWorkspacesWithDeps");
    expect(runtime).not.toHaveProperty("SessionManager");
    expect(runtime).not.toHaveProperty("SessionRegistry");
    expect(runtime.resolveAgentContextTreeBinding).toBeDefined();
    expect(runtime.registerShutdownHook).toBeDefined();
  });

  it("loads observability barrel exports", async () => {
    const observability = await import("../observability/index.js");

    expect(observability.createLogger).toBeDefined();
    expect(observability.rootLogger).toBeDefined();
  });
});
