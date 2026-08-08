import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const clientSrc = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientPkgRoot = join(clientSrc, "..");

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
    // S1d/S2 contracts + provider-support entries are not package public APIs /
    // temporary subpath exports.
    expect(api).not.toHaveProperty("contracts");
    expect(api).not.toHaveProperty("provider-support");
    expect(api).not.toHaveProperty("prepareManagedSession");
    const publicKeys = Object.keys(api).sort();
    expect(publicKeys).not.toContain("SessionManager");
    expect(publicKeys).not.toContain("SessionRegistry");
    expect(publicKeys).not.toContain("noopDeliveryToken");
    expect(publicKeys).not.toContain("requireDeliveryToken");
    expect(publicKeys).not.toContain("prepareManagedSession");

    const pkg = JSON.parse(readFileSync(join(clientPkgRoot, "package.json"), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const exportPaths = Object.keys(pkg.exports ?? {}).sort();
    expect(exportPaths).toEqual([".", "./observability"]);
    expect(exportPaths).not.toContain("./contracts");
    expect(exportPaths).not.toContain("./provider-support");
    expect(pkg.exports).not.toHaveProperty("./contracts");
    expect(pkg.exports).not.toHaveProperty("./provider-support");

    const rootIndex = readFileSync(join(clientSrc, "index.ts"), "utf8");
    expect(rootIndex).not.toMatch(/runtime\/contracts|from ["']\.\/runtime\/contracts\.js["']/);
    expect(rootIndex).not.toMatch(/provider-support|prepareManagedSession/);
  });

  it("loads runtime barrel exports", async () => {
    const runtime = await import("../runtime/index.js");

    expect(runtime.AgentSlot).toBeDefined();
    expect(runtime.AgentRuntime).toBeDefined();
    expect(runtime.cleanAgentWorkspaces).toBeDefined();
    expect(runtime).not.toHaveProperty("cleanAgentWorkspacesWithDeps");
    expect(runtime).not.toHaveProperty("SessionManager");
    expect(runtime).not.toHaveProperty("SessionRegistry");
    expect(runtime).not.toHaveProperty("contracts");
    expect(runtime).not.toHaveProperty("prepareManagedSession");
    expect(runtime).not.toHaveProperty("providerSupport");
    expect(runtime.resolveAgentContextTreeBinding).toBeDefined();
    expect(runtime.registerShutdownHook).toBeDefined();

    const runtimeIndex = readFileSync(join(clientSrc, "runtime/index.ts"), "utf8");
    expect(runtimeIndex).not.toMatch(/from ["']\.\/contracts\.js["']/);
    expect(runtimeIndex).not.toMatch(/provider-support|prepareManagedSession/);
  });

  it("loads observability barrel exports", async () => {
    const observability = await import("../observability/index.js");

    expect(observability.createLogger).toBeDefined();
    expect(observability.rootLogger).toBeDefined();
  });
});
