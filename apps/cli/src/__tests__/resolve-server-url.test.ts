import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression test for the CLI's `chat send` (and any other SDK-using command)
 * silently falling back to http://localhost:8000 when client.yaml points elsewhere.
 *
 * Root cause: resolveServerUrl() internally calls getClientConfig(), which reads
 * a singleton that is only populated by initConfig(). The `agent` subcommand
 * never calls initConfig, so getClientConfig() throws "Config not initialized",
 * and the catch in agent.ts defaults to http://localhost:8000 — diverging from
 * doctor/status which use resolveConfigReadonly and work correctly.
 *
 * Fix: resolveServerUrl should read the yaml via resolveConfigReadonly (no
 * singleton dependency), same as doctor/status.
 */
describe("resolveServerUrl without prior initConfig", () => {
  let testHome: string;
  let originalHome: string | undefined;
  let originalServerUrl: string | undefined;

  beforeEach(() => {
    testHome = join(tmpdir(), `ft-hub-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testHome, "config"), { recursive: true });

    originalHome = process.env.FIRST_TREE_HOME;
    originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
    process.env.FIRST_TREE_HOME = testHome;
    delete process.env.FIRST_TREE_SERVER_URL;

    // Force module-level constants (DEFAULT_HOME_DIR / DEFAULT_CONFIG_DIR) to
    // be re-evaluated from the updated env in the dynamic import below.
    vi.resetModules();
  });

  afterEach(() => {
    if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });

    if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
    else process.env.FIRST_TREE_HOME = originalHome;

    if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
    else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  });

  it("returns server.url from client.yaml when initConfig was never called", async () => {
    writeFileSync(join(testHome, "config", "client.yaml"), "server:\n  url: https://test-staging.example.com\n");

    const { resolveServerUrl } = await import("../core/bootstrap.js");

    // Before the fix this throws "Config not initialized. Call initConfig() first."
    // After the fix it should return the URL from the yaml file.
    expect(resolveServerUrl()).toBe("https://test-staging.example.com");
  });

  it("prefers flag argument over yaml", async () => {
    writeFileSync(join(testHome, "config", "client.yaml"), "server:\n  url: https://yaml.example.com\n");

    const { resolveServerUrl } = await import("../core/bootstrap.js");
    expect(resolveServerUrl("https://flag.example.com")).toBe("https://flag.example.com");
  });

  it("prefers FIRST_TREE_SERVER_URL env var over yaml", async () => {
    writeFileSync(join(testHome, "config", "client.yaml"), "server:\n  url: https://yaml.example.com\n");
    process.env.FIRST_TREE_SERVER_URL = "https://env.example.com";

    const { resolveServerUrl } = await import("../core/bootstrap.js");
    expect(resolveServerUrl()).toBe("https://env.example.com");
  });

  it("throws a clear error when neither env, flag, nor yaml provides a URL", async () => {
    // No client.yaml written — directory is empty.
    const { resolveServerUrl } = await import("../core/bootstrap.js");

    expect(() => resolveServerUrl()).toThrow(/Server URL not configured/);
  });

  it("throws a clear error when yaml exists but server.url is absent", async () => {
    // yaml file is well-formed but missing the server.url field — must not
    // silently return undefined or fall through to a default.
    writeFileSync(join(testHome, "config", "client.yaml"), "logLevel: info\nserver: {}\n");

    const { resolveServerUrl } = await import("../core/bootstrap.js");
    expect(() => resolveServerUrl()).toThrow(/Server URL not configured/);
  });
});
