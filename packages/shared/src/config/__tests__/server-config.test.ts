import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initConfig } from "../resolver.js";
import { createServerConfigSchema, getServerConfig, serverConfigSchema } from "../server-config.js";
import { resetConfig, setConfig } from "../singleton.js";

describe("server config", () => {
  const savedNodeEnv = process.env.NODE_ENV;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    vi.unstubAllEnvs();
    resetConfig();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.resetModules();
  });

  function makeTempConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "first-tree-server-config-"));
    tempDirs.push(dir);
    return dir;
  }

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

  it("trims allowed organization id and treats blank values as disabled", () => {
    const fieldSchema = serverConfigSchema.access.shape.allowedOrganizationId.schema;

    expect(fieldSchema.parse("  org_123  ")).toBe("org_123");
    expect(fieldSchema.parse("")).toBeUndefined();
    expect(fieldSchema.parse("   ")).toBeUndefined();
  });

  it("does not auto-generate server secrets when disabled", async () => {
    const configDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_DATABASE_URL", "postgres://first-tree:test@localhost:5432/firsttree");

    await expect(
      initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      }),
    ).rejects.toThrow(/secrets\.(jwtSecret|encryptionKey)/);

    expect(existsSync(join(configDir, "server.yaml"))).toBe(false);
  });

  it("keeps local server secret auto-generation enabled by default", async () => {
    const configDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_DATABASE_URL", "postgres://first-tree:test@localhost:5432/firsttree");

    const config = await initConfig({
      schema: createServerConfigSchema(),
      role: "server",
      configDir,
    });

    expect(config.secrets.jwtSecret).toHaveLength(43);
    expect(config.secrets.encryptionKey).toHaveLength(64);
    const yaml = readFileSync(join(configDir, "server.yaml"), "utf8");
    expect(yaml).toContain("jwtSecret:");
    expect(yaml).toContain("encryptionKey:");
  });

  it("accepts operator-provided production server secrets without writing generated YAML", async () => {
    const configDir = makeTempConfigDir();
    const jwtSecret = "operator-jwt-secret";
    const encryptionKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    vi.stubEnv("FIRST_TREE_DATABASE_URL", "postgres://first-tree:test@localhost:5432/firsttree");
    vi.stubEnv("FIRST_TREE_JWT_SECRET", jwtSecret);
    vi.stubEnv("FIRST_TREE_ENCRYPTION_KEY", encryptionKey);

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.secrets).toEqual({ jwtSecret, encryptionKey });
    expect(existsSync(join(configDir, "server.yaml"))).toBe(false);
  });
});
