import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clientConfigSchema, getClientConfig } from "../config/client-config.js";
import { UPDATE_POLICY_DEFAULT } from "../config/phase.js";
import { initConfig } from "../config/resolver.js";
import { resetConfig } from "../config/singleton.js";

describe("client config update block", () => {
  let dir: string;
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "FIRST_TREE_SERVER_URL",
    "FIRST_TREE_CLIENT_ID",
    "FIRST_TREE_UPDATE_POLICY",
    "FIRST_TREE_UPDATE_RESTART_QUIET_SECONDS",
    "FIRST_TREE_UPDATE_RESTART_CHECK_INTERVAL_SECONDS",
    "FIRST_TREE_UPDATE_PROMPT_TIMEOUT_SECONDS",
  ];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ftHub-cfg-"));
    for (const k of envKeys) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.FIRST_TREE_SERVER_URL = "http://localhost:8000";
    process.env.FIRST_TREE_CLIENT_ID = "client_0a1b2c3d";
    resetConfig();
  });

  afterEach(() => {
    for (const k of envKeys) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
    resetConfig();
  });

  it("resolves defaults from UPDATE_POLICY_DEFAULT + schema defaults", async () => {
    const cfg = await initConfig({
      schema: clientConfigSchema,
      role: "client",
      configDir: dir,
    });
    expect(cfg.update.policy).toBe(UPDATE_POLICY_DEFAULT);
    expect(cfg.update.restart_quiet_seconds).toBe(30);
    expect(cfg.update.restart_check_interval_seconds).toBe(10);
    expect(cfg.update.prompt_timeout_seconds).toBe(60);
    expect(getClientConfig()).toBe(cfg);
  });

  it("honours env-var overrides", async () => {
    process.env.FIRST_TREE_UPDATE_POLICY = "off";
    process.env.FIRST_TREE_UPDATE_RESTART_QUIET_SECONDS = "120";
    process.env.FIRST_TREE_UPDATE_PROMPT_TIMEOUT_SECONDS = "90";
    const cfg = await initConfig({
      schema: clientConfigSchema,
      role: "client",
      configDir: dir,
    });
    expect(cfg.update.policy).toBe("off");
    expect(cfg.update.restart_quiet_seconds).toBe(120);
    expect(cfg.update.prompt_timeout_seconds).toBe(90);
  });

  it("rejects an invalid policy literal", async () => {
    process.env.FIRST_TREE_UPDATE_POLICY = "aggressive";
    await expect(
      initConfig({
        schema: clientConfigSchema,
        role: "client",
        configDir: dir,
      }),
    ).rejects.toThrow(/Configuration validation failed/);
  });
});
