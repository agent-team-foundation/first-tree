import { afterEach, describe, expect, it, vi } from "vitest";
import { getServerConfig } from "../server-config.js";
import { resetConfig, setConfig } from "../singleton.js";

describe("server config", () => {
  const savedNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    resetConfig();
    vi.resetModules();
  });

  it("returns the initialized server config object", () => {
    const config = { channel: "dev" };
    setConfig(config);

    expect(getServerConfig()).toBe(config);
  });

  it("defaults log format to pretty outside production and json in production", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "development";
    const devModule = await import("../server-config.js");
    expect(devModule.serverConfigSchema.observability.logging.format.schema.parse(undefined)).toBe("pretty");

    vi.resetModules();
    process.env.NODE_ENV = "production";
    const prodModule = await import("../server-config.js");
    expect(prodModule.serverConfigSchema.observability.logging.format.schema.parse(undefined)).toBe("json");
  });
});
