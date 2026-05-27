import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadAgents } from "../loader.js";
import {
  collectMissingPrompts,
  defaultConfigDir,
  defaultDataDir,
  defaultHome,
  getConfigMeta,
  getConfigValue,
  initConfig,
  readConfigFile,
  resetConfigMeta,
  resolveConfigReadonly,
  setConfigValue,
} from "../resolver.js";
import { defineConfig, field, optional } from "../schema.js";
import { getConfig, resetConfig } from "../singleton.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `first-tree-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
  resetConfig();
  resetConfigMeta();
});

afterEach(() => {
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
  // Restore env vars
  vi.unstubAllEnvs();
});

const simpleSchema = defineConfig({
  server: {
    port: field(z.number().default(8000), { env: "TEST_PORT" }),
    host: field(z.string().default("127.0.0.1")),
  },
  secrets: {
    key: field(z.string(), { auto: "random:hex:16", secret: true }),
  },
});

describe("default paths", () => {
  it("derives default directories from FIRST_TREE_HOME", () => {
    vi.stubEnv("FIRST_TREE_HOME", join(testDir, "home"));

    expect(defaultHome()).toBe(join(testDir, "home"));
    expect(defaultConfigDir()).toBe(join(testDir, "home", "config"));
    expect(defaultDataDir()).toBe(join(testDir, "home", "data"));
  });

  it("falls back to the OS home when FIRST_TREE_HOME is unset", () => {
    vi.stubEnv("FIRST_TREE_HOME", undefined);

    expect(defaultHome()).toContain(".first-tree");
  });
});

describe("initConfig", () => {
  it("uses Zod defaults when no values provided", async () => {
    const config = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    expect(config.server.port).toBe(8000);
    expect(config.server.host).toBe("127.0.0.1");
    expect(typeof config.secrets.key).toBe("string");
    expect(config.secrets.key.length).toBeGreaterThan(0);
  });

  it("reads values from YAML file", async () => {
    writeFileSync(join(testDir, "test.yaml"), "server:\n  port: 9000\n  host: 0.0.0.0\n");

    const config = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    expect(config.server.port).toBe(9000);
    expect(config.server.host).toBe("0.0.0.0");
  });

  it("env vars override file values", async () => {
    writeFileSync(join(testDir, "test.yaml"), "server:\n  port: 9000\n");
    vi.stubEnv("TEST_PORT", "3000");

    const config = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    expect(config.server.port).toBe(3000);
  });

  it("CLI args override everything", async () => {
    writeFileSync(join(testDir, "test.yaml"), "server:\n  port: 9000\n");
    vi.stubEnv("TEST_PORT", "3000");

    const config = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
      cliArgs: { server: { port: 4000 } },
    });

    expect(config.server.port).toBe(4000);
  });

  it("auto-generates missing values and writes back to YAML", async () => {
    await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    // Should have written auto-generated key to YAML
    const yamlContent = readFileSync(join(testDir, "test.yaml"), "utf-8");
    const parsed = parseYaml(yamlContent) as { secrets: { key: string } };
    expect(typeof parsed.secrets.key).toBe("string");
    expect(parsed.secrets.key.length).toBe(32); // 16 bytes as hex
  });

  it("reuses auto-generated values on second init", async () => {
    const config1 = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    resetConfig();
    resetConfigMeta();

    const config2 = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    // Same key because it was persisted to YAML
    expect(config2.secrets.key).toBe(config1.secrets.key);
  });

  it("stores config as frozen singleton", async () => {
    const config = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(getConfig()).toBe(config);
  });

  it("tracks field sources in meta", async () => {
    writeFileSync(join(testDir, "test.yaml"), "server:\n  port: 9000\n");
    vi.stubEnv("TEST_PORT", "3000");

    await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    const meta = getConfigMeta();
    expect(meta.get("server.port")?.source).toBe("env");
    expect(meta.get("server.host")?.source).toBe("default");
    expect(meta.get("secrets.key")?.source).toBe("auto");
    expect(meta.get("secrets.key")?.secret).toBe(true);
  });

  it("uses custom auto-generators", async () => {
    const schema = defineConfig({
      db: {
        url: field(z.string(), { auto: "custom-pg" }),
      },
    });

    const config = await initConfig({
      schema,
      role: "test",
      configDir: testDir,
      autoGenerators: {
        "custom-pg": async () => "postgresql://custom:5432/db",
      },
    });

    expect(config.db.url).toBe("postgresql://custom:5432/db");
  });

  it("fails validation for missing required fields", async () => {
    const schema = defineConfig({
      required: field(z.string()),
    });

    await expect(initConfig({ schema, role: "test", configDir: testDir })).rejects.toThrow(
      "Configuration validation failed",
    );
  });

  it("coerces env var strings to numbers", async () => {
    vi.stubEnv("TEST_PORT", "9999");

    const config = await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    expect(config.server.port).toBe(9999);
    expect(typeof config.server.port).toBe("number");
  });

  it("keeps invalid numeric env vars for validation to reject", async () => {
    vi.stubEnv("TEST_PORT", "not-a-number");

    await expect(
      initConfig({
        schema: simpleSchema,
        role: "test",
        configDir: testDir,
      }),
    ).rejects.toThrow("Configuration validation failed");
  });

  it("coerces boolean env vars and rejects invalid boolean text", async () => {
    const schema = defineConfig({
      feature: {
        enabled: field(z.boolean().optional(), { env: "TEST_FEATURE_ENABLED" }),
      },
    });

    vi.stubEnv("TEST_FEATURE_ENABLED", "true");
    await expect(initConfig({ schema, role: "test", configDir: testDir })).resolves.toMatchObject({
      feature: { enabled: true },
    });

    resetConfig();
    resetConfigMeta();
    vi.stubEnv("TEST_FEATURE_ENABLED", "0");
    await expect(initConfig({ schema, role: "test", configDir: testDir })).resolves.toMatchObject({
      feature: { enabled: false },
    });

    resetConfig();
    resetConfigMeta();
    vi.stubEnv("TEST_FEATURE_ENABLED", "not-a-boolean");
    await expect(initConfig({ schema, role: "test", configDir: testDir })).rejects.toThrow(
      "Configuration validation failed",
    );
  });

  it("uses the default config directory when configDir is omitted", async () => {
    vi.stubEnv("FIRST_TREE_HOME", testDir);

    const config = await initConfig({
      schema: simpleSchema,
      role: "test",
    });

    expect(config.server.port).toBe(8000);
    expect(existsSync(join(testDir, "config", "test.yaml"))).toBe(true);
  });

  it("deep-merges auto-generated values into existing file groups", async () => {
    writeFileSync(join(testDir, "test.yaml"), "server:\n  host: localhost\nsecrets:\n  existing: keep\n");

    await initConfig({
      schema: simpleSchema,
      role: "test",
      configDir: testDir,
    });

    const yamlContent = readFileSync(join(testDir, "test.yaml"), "utf-8");
    const parsed = parseYaml(yamlContent);
    expect(parsed).toMatchObject({
      server: { host: "localhost" },
      secrets: { existing: "keep" },
    });
    expect(parsed).toHaveProperty("secrets.key");
  });

  it("supports built-in client-id and base64url auto-generation strategies", async () => {
    const schema = defineConfig({
      client: {
        id: field(z.string(), { auto: "client-id" }),
        secret: field(z.string(), { auto: "random:base64url:6" }),
      },
    });

    const config = await initConfig({
      schema,
      role: "test",
      configDir: testDir,
    });

    expect(config.client.id).toMatch(/^client_[a-f0-9]{8}$/);
    expect(config.client.secret).toHaveLength(8);
  });

  it("rejects unknown auto-generation strategies and encodings", async () => {
    const unknownStrategySchema = defineConfig({
      value: field(z.string(), { auto: "unknown" }),
    });
    await expect(initConfig({ schema: unknownStrategySchema, role: "test", configDir: testDir })).rejects.toThrow(
      "Unknown auto-generation strategy",
    );

    resetConfig();
    resetConfigMeta();

    const unknownEncodingSchema = defineConfig({
      value: field(z.string(), { auto: "random:utf8:1" }),
    });
    await expect(initConfig({ schema: unknownEncodingSchema, role: "test", configDir: testDir })).rejects.toThrow(
      "Unknown random encoding",
    );
  });

  it("rejects a random auto-generation strategy with an empty encoding capture", async () => {
    const originalExec = RegExp.prototype.exec;
    const execSpy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, value: string) {
      if (this.source === "^random:(\\w+):(\\d+)$" && value === "random:empty-encoding:1") {
        const match = /random:empty-encoding:1/.exec(value);
        if (match) {
          match[1] = "";
          match[2] = "1";
        }
        return match;
      }
      return originalExec.call(this, value);
    });

    const schema = defineConfig({
      value: field(z.string(), { auto: "random:empty-encoding:1" }),
    });

    try {
      await expect(initConfig({ schema, role: "test", configDir: testDir })).rejects.toThrow(
        "Invalid auto-generation strategy",
      );
    } finally {
      execSpy.mockRestore();
    }
  });
});

describe("optional groups", () => {
  const schemaWithOptional = defineConfig({
    name: field(z.string().default("test")),
    extra: optional({
      repo: field(z.string(), { env: "TEST_REPO" }),
      branch: field(z.string().default("main")),
    }),
  });

  it("optional group is undefined when no fields are set", async () => {
    const config = await initConfig({
      schema: schemaWithOptional,
      role: "test",
      configDir: testDir,
    });

    expect(config.extra).toBeUndefined();
  });

  it("optional group is present when at least one field is set", async () => {
    vi.stubEnv("TEST_REPO", "org/repo");

    const config = await initConfig({
      schema: schemaWithOptional,
      role: "test",
      configDir: testDir,
    });

    expect(config.extra).toBeDefined();
    expect(config.extra?.repo).toBe("org/repo");
    expect(config.extra?.branch).toBe("main");
  });

  it("optional group from file", async () => {
    writeFileSync(join(testDir, "test.yaml"), "extra:\n  repo: org/repo\n");

    const config = await initConfig({
      schema: schemaWithOptional,
      role: "test",
      configDir: testDir,
    });

    expect(config.extra?.repo).toBe("org/repo");
    expect(config.extra?.branch).toBe("main");
  });

  it("optional group from CLI args", async () => {
    const config = await initConfig({
      schema: schemaWithOptional,
      role: "test",
      configDir: testDir,
      cliArgs: { extra: { repo: "org/repo" } },
    });

    expect(config.extra?.repo).toBe("org/repo");
    expect(config.extra?.branch).toBe("main");
  });
});

describe("setConfigValue / getConfigValue / readConfigFile", () => {
  it("set and get a value", () => {
    const path = join(testDir, "test.yaml");
    setConfigValue(path, "database.url", "postgres://localhost");
    expect(getConfigValue(path, "database.url")).toBe("postgres://localhost");
  });

  it("set preserves existing values", () => {
    const path = join(testDir, "test.yaml");
    setConfigValue(path, "database.url", "postgres://localhost");
    setConfigValue(path, "server.port", 9000);
    expect(getConfigValue(path, "database.url")).toBe("postgres://localhost");
    expect(getConfigValue(path, "server.port")).toBe(9000);
  });

  it("readConfigFile returns all values", () => {
    const path = join(testDir, "test.yaml");
    setConfigValue(path, "a.b", 1);
    setConfigValue(path, "a.c", 2);
    const data = readConfigFile(path);
    expect(data).toEqual({ a: { b: 1, c: 2 } });
  });

  it("returns undefined for non-existent file", () => {
    expect(getConfigValue(join(testDir, "nope.yaml"), "key")).toBeUndefined();
    expect(readConfigFile(join(testDir, "nope.yaml"))).toEqual({});
  });

  it("returns empty values for scalar config files", () => {
    const path = join(testDir, "test.yaml");
    writeFileSync(path, "plain-value\n");

    expect(getConfigValue(path, "database.url")).toBeUndefined();
    expect(readConfigFile(path)).toEqual({});
  });

  it("creates missing parent directories when setting a value", () => {
    const path = join(testDir, "nested", "test.yaml");

    setConfigValue(path, "database.url", "postgres://localhost");

    expect(getConfigValue(path, "database.url")).toBe("postgres://localhost");
  });

  it("handles sparse dot paths defensively when setting a value", () => {
    const originalSplit = String.prototype.split;
    const splitSpy = vi.spyOn(String.prototype, "split").mockImplementation(function (
      this: string,
      separator: string | RegExp | { [Symbol.split](string: string, limit?: number): string[] },
      limit?: number,
    ) {
      if (this.toString() === "__sparse__.leaf" && separator === ".") {
        const path = ["placeholder", "leaf"];
        delete path[0];
        return path;
      }
      return Reflect.apply(originalSplit, this, [separator, limit]);
    });

    const path = join(testDir, "test.yaml");
    try {
      setConfigValue(path, "__sparse__.leaf", "value");
    } finally {
      splitSpy.mockRestore();
    }
    expect(getConfigValue(path, "leaf")).toBe("value");
  });
});

describe("collectMissingPrompts", () => {
  const schemaWithPrompts = defineConfig({
    database: {
      url: field(z.string(), { env: "TEST_DB_URL", prompt: { message: "DB URL:" } }),
    },
    server: {
      port: field(z.number().default(8000), { prompt: { message: "Port:", default: "8000" } }),
    },
    secrets: {
      key: field(z.string(), { auto: "random:hex:16", secret: true }),
    },
    extra: optional({
      repo: field(z.string(), { prompt: { message: "Repo:" } }),
    }),
  });

  it("returns prompts for missing required fields", () => {
    const missing = collectMissingPrompts({
      schema: schemaWithPrompts as Record<string, unknown>,
      role: "test",
      configDir: testDir,
    });

    const paths = missing.map((m) => m.dotPath);
    expect(paths).toContain("database.url");
    expect(paths).toContain("server.port");
  });

  it("skips fields with auto but no prompt", () => {
    const missing = collectMissingPrompts({
      schema: schemaWithPrompts as Record<string, unknown>,
      role: "test",
      configDir: testDir,
    });

    const paths = missing.map((m) => m.dotPath);
    expect(paths).not.toContain("secrets.key");
  });

  it("includes fields with both auto and prompt (prompt takes priority)", () => {
    const schemaAutoPrompt = defineConfig({
      db: {
        url: field(z.string(), {
          auto: "docker-pg",
          prompt: {
            message: "DB:",
            type: "select",
            choices: [
              { name: "Docker", value: "__auto__" },
              { name: "URL", value: "__input__" },
            ],
          },
        }),
      },
    });

    const missing = collectMissingPrompts({
      schema: schemaAutoPrompt as Record<string, unknown>,
      role: "test",
      configDir: testDir,
    });

    const paths = missing.map((m) => m.dotPath);
    expect(paths).toContain("db.url");
  });

  it("skips fields in optional groups", () => {
    const missing = collectMissingPrompts({
      schema: schemaWithPrompts as Record<string, unknown>,
      role: "test",
      configDir: testDir,
    });

    const paths = missing.map((m) => m.dotPath);
    expect(paths).not.toContain("extra.repo");
  });

  it("skips fields that already have values in file", () => {
    writeFileSync(join(testDir, "test.yaml"), "database:\n  url: postgres://localhost\n");

    const missing = collectMissingPrompts({
      schema: schemaWithPrompts as Record<string, unknown>,
      role: "test",
      configDir: testDir,
    });

    const paths = missing.map((m) => m.dotPath);
    expect(paths).not.toContain("database.url");
    expect(paths).toContain("server.port");
  });

  it("skips fields provided via env vars", () => {
    vi.stubEnv("TEST_DB_URL", "postgres://env");

    const missing = collectMissingPrompts({
      schema: schemaWithPrompts as Record<string, unknown>,
      role: "test",
      configDir: testDir,
    });

    const paths = missing.map((m) => m.dotPath);
    expect(paths).not.toContain("database.url");
  });

  it("skips fields provided via CLI args", () => {
    const missing = collectMissingPrompts({
      schema: schemaWithPrompts as Record<string, unknown>,
      role: "test",
      configDir: testDir,
      cliArgs: { database: { url: "postgres://cli" } },
    });

    const paths = missing.map((m) => m.dotPath);
    expect(paths).not.toContain("database.url");
  });

  it("returns empty when all fields are satisfied", () => {
    writeFileSync(join(testDir, "test.yaml"), "database:\n  url: postgres://x\nserver:\n  port: 3000\n");

    const missing = collectMissingPrompts({
      schema: schemaWithPrompts as Record<string, unknown>,
      role: "test",
      configDir: testDir,
    });

    expect(missing).toHaveLength(0);
  });

  it("uses the default config directory when collecting prompts", () => {
    vi.stubEnv("FIRST_TREE_HOME", testDir);

    const missing = collectMissingPrompts({
      schema: schemaWithPrompts,
      role: "test",
    });

    expect(missing.map((field) => field.dotPath)).toContain("database.url");
  });
});

describe("config metadata", () => {
  it("throws before config metadata is initialized", () => {
    expect(() => getConfigMeta()).toThrow("Config not initialized");
  });
});

describe("resolveConfigReadonly", () => {
  const readonlySchema = defineConfig({
    server: {
      port: field(z.number().default(8000), { env: "READONLY_PORT" }),
      host: field(z.string().default("127.0.0.1")),
    },
    feature: {
      enabled: field(z.boolean().optional(), { env: "READONLY_FEATURE_ENABLED" }),
    },
    secret: field(z.string(), { auto: "random:hex:4" }),
  });

  it("resolves env, file, and defaults without writing generated values", () => {
    writeFileSync(join(testDir, "test.yaml"), "server:\n  port: 9000\n  host: 0.0.0.0\n");
    vi.stubEnv("READONLY_PORT", "3000");
    vi.stubEnv("READONLY_FEATURE_ENABLED", "1");

    const config = resolveConfigReadonly({
      schema: readonlySchema,
      role: "test",
      configDir: testDir,
    });

    expect(config).toEqual({
      server: { port: 3000, host: "0.0.0.0" },
      feature: { enabled: true },
    });
    expect(readFileSync(join(testDir, "test.yaml"), "utf-8")).not.toContain("secret:");
  });

  it("uses default config directory and ignores non-object YAML", () => {
    vi.stubEnv("FIRST_TREE_HOME", testDir);
    mkdirSync(join(testDir, "config"), { recursive: true });
    writeFileSync(join(testDir, "config", "test.yaml"), "plain-value\n");

    const config = resolveConfigReadonly({
      schema: readonlySchema,
      role: "test",
    });

    expect(config).toEqual({
      server: { port: 8000, host: "127.0.0.1" },
    });
  });
});

describe("loadAgents", () => {
  const agentSchema = defineConfig({
    token: field(z.string(), { secret: true }),
  });

  it("loads agents from subdirectories", () => {
    const agentsDir = join(testDir, "agents");
    mkdirSync(join(agentsDir, "agent-a"), { recursive: true });
    mkdirSync(join(agentsDir, "agent-b"), { recursive: true });
    writeFileSync(join(agentsDir, "agent-a", "agent.yaml"), "token: aht_aaa\n");
    writeFileSync(join(agentsDir, "agent-b", "agent.yaml"), "token: aht_bbb\n");

    const agents = loadAgents({ schema: agentSchema, agentsDir });

    expect(agents.size).toBe(2);
    expect(agents.get("agent-a")?.token).toBe("aht_aaa");
    expect(agents.get("agent-b")?.token).toBe("aht_bbb");
  });

  it("returns empty map when directory does not exist", () => {
    const agents = loadAgents({ schema: agentSchema, agentsDir: join(testDir, "nope") });
    expect(agents.size).toBe(0);
  });

  it("skips directories without agent.yaml", () => {
    const agentsDir = join(testDir, "agents");
    mkdirSync(join(agentsDir, "agent-a"), { recursive: true });
    mkdirSync(join(agentsDir, "agent-b"), { recursive: true });
    writeFileSync(join(agentsDir, "agent-a", "agent.yaml"), "token: aht_aaa\n");
    // agent-b has no agent.yaml

    const agents = loadAgents({ schema: agentSchema, agentsDir });
    expect(agents.size).toBe(1);
    expect(agents.has("agent-a")).toBe(true);
    expect(agents.has("agent-b")).toBe(false);
  });

  it("skips non-directory entries in the agents directory", () => {
    const agentsDir = join(testDir, "agents");
    mkdirSync(join(agentsDir, "agent-a"), { recursive: true });
    writeFileSync(join(agentsDir, "README.md"), "not an agent config\n");
    writeFileSync(join(agentsDir, "agent-a", "agent.yaml"), "token: aht_aaa\n");

    const agents = loadAgents({ schema: agentSchema, agentsDir });

    expect(agents.size).toBe(1);
    expect(agents.has("agent-a")).toBe(true);
    expect(agents.has("README.md")).toBe(false);
  });
});
