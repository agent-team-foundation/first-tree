import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadAgents } from "../loader.js";
import {
  collectMissingPrompts,
  getConfigMeta,
  getConfigValue,
  initConfig,
  readConfigFile,
  resetConfigMeta,
  setConfigValue,
} from "../resolver.js";
import { defineConfig, field, optional } from "../schema.js";
import { getConfig, resetConfig } from "../singleton.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `agent-hub-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
});
