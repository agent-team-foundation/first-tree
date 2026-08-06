import { describe, expect, it } from "vitest";

describe("public barrel exports", { timeout: 30_000 }, () => {
  it("loads the package entrypoint exports", async () => {
    const api = await import("../index.js");

    expect(api.FirstTreeHubSDK).toBeDefined();
    expect(api.FirstTreeSDK).toBe(api.FirstTreeHubSDK);
    expect(api.ClientConnection).toBeDefined();
    expect(api.AgentSlot).toBeDefined();
    expect(api.AgentRuntime).toBeDefined();
    expect(api.SessionManager).toBeDefined();
    expect(api.createBuiltinHandlerRegistry).toBeDefined();
    expect(api.resolveAndLogClaudeExecutable).toBeDefined();
    expect(api).not.toHaveProperty("registerBuiltinHandlers");
    expect(api).not.toHaveProperty("registerHandler");
    expect(api).not.toHaveProperty("getHandlerFactory");
    expect(api).not.toHaveProperty("hasHandler");
  });

  it("loads runtime barrel exports", async () => {
    const runtime = await import("../runtime/index.js");

    expect(runtime.AgentSlot).toBeDefined();
    expect(runtime.AgentRuntime).toBeDefined();
    expect(runtime.resolveAgentContextTreeBinding).toBeDefined();
    expect(runtime.registerShutdownHook).toBeDefined();
  });

  it("loads observability barrel exports", async () => {
    const observability = await import("../observability/index.js");

    expect(observability.createLogger).toBeDefined();
    expect(observability.rootLogger).toBeDefined();
  });
});
