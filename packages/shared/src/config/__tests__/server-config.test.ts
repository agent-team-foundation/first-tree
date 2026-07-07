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

  function stubRequiredProductionConfig(): void {
    vi.stubEnv("FIRST_TREE_DATABASE_URL", "postgres://first-tree:test@localhost:5432/firsttree");
    vi.stubEnv("FIRST_TREE_JWT_SECRET", "operator-jwt-secret");
    vi.stubEnv("FIRST_TREE_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
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

  it("keeps growth landing pages disabled by default and enables them via env", async () => {
    const defaultConfigDir = makeTempConfigDir();
    stubRequiredProductionConfig();

    const defaultConfig = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: defaultConfigDir,
    });

    expect(defaultConfig.growth.landingPagesEnabled).toBe(false);
    expect(defaultConfig.growth.landingCampaignMaxAgentTurns).toBe(1);

    resetConfig();
    const enabledConfigDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_GROWTH_LANDING_PAGES_ENABLED", "true");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_MAX_AGENT_TURNS", "4");

    const enabledConfig = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: enabledConfigDir,
    });

    expect(enabledConfig.growth.landingPagesEnabled).toBe(true);
    expect(enabledConfig.growth.landingCampaignMaxAgentTurns).toBe(4);
  });

  it("resolves landing campaign official service ids only when configured", async () => {
    const defaultConfigDir = makeTempConfigDir();
    stubRequiredProductionConfig();

    const defaultConfig = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: defaultConfigDir,
    });

    expect(defaultConfig.growth.landingCampaigns).toBeUndefined();
    expect(defaultConfig.growth).not.toHaveProperty("landingCampaignEnabledSlugs");

    resetConfig();
    const configuredDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_SERVICE_USER_ID", "  user_service  ");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_SERVICE_ORG_ID", "  org_service  ");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_CLIENT_ID", "  client_official  ");

    const configured = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: configuredDir,
    });

    expect(configured.growth.landingCampaigns).toEqual({
      serviceUserId: "user_service",
      serviceOrgId: "org_service",
      clientId: "client_official",
      runtimeProvider: "codex",
    });
  });

  it("rejects invalid landing campaign max turn limits", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_MAX_AGENT_TURNS", "0");

    await expect(
      initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      }),
    ).rejects.toThrow(/landingCampaignMaxAgentTurns/);
  });

  it("defaults landing campaign runtime provider to codex and accepts claude-code", async () => {
    const defaultDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_SERVICE_USER_ID", "user_service");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_SERVICE_ORG_ID", "org_service");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_CLIENT_ID", "client_official");

    const defaultProvider = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: defaultDir,
    });

    expect(defaultProvider.growth.landingCampaigns?.runtimeProvider).toBe("codex");

    resetConfig();
    const claudeDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_SERVICE_ORG_ID", "org_service");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_RUNTIME_PROVIDER", "claude-code");

    const claudeProvider = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: claudeDir,
    });

    expect(claudeProvider.growth.landingCampaigns?.runtimeProvider).toBe("claude-code");
  });

  it("rejects unsupported landing campaign runtime providers", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_SERVICE_USER_ID", "user_service");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_SERVICE_ORG_ID", "org_service");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_CLIENT_ID", "client_official");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_RUNTIME_PROVIDER", "claude-code-tui");

    await expect(
      initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      }),
    ).rejects.toThrow(/Landing campaign runtime provider must be codex or claude-code/);
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

  it("resolves only the global rate-limit max env", async () => {
    const configDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_DATABASE_URL", "postgres://first-tree:test@localhost:5432/firsttree");
    vi.stubEnv("FIRST_TREE_JWT_SECRET", "operator-jwt-secret");
    vi.stubEnv("FIRST_TREE_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    vi.stubEnv("FIRST_TREE_RATE_LIMIT_MAX", "1234");

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.rateLimit).toEqual({ max: 1234 });
  });

  it("resolves connect bootstrap portable env overrides", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_CONNECT_BOOTSTRAP_METHOD", "portable");
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", "https://downloads.example.test");

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.connectBootstrap).toEqual({
      method: "portable",
      portableDownloadBaseUrl: "https://downloads.example.test",
    });
  });

  it("uses inbox delivery fairness defaults when the inbox group is active", () => {
    expect(serverConfigSchema.inbox.shape.maxInFlightPerAgent.schema.parse(undefined)).toBe(8192);
    expect(serverConfigSchema.inbox.shape.maxInFlightPerAgentChat.schema.parse(undefined)).toBe(8);
  });

  it("resolves inbox delivery fairness env overrides", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_INBOX_MAX_IN_FLIGHT_PER_AGENT", "4096");
    vi.stubEnv("FIRST_TREE_INBOX_MAX_IN_FLIGHT_PER_AGENT_CHAT", "12");

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.inbox).toEqual({
      maxInFlightPerAgent: 4096,
      maxInFlightPerAgentChat: 12,
    });
  });

  it("ignores removed per-route rate-limit env vars", async () => {
    const configDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_DATABASE_URL", "postgres://first-tree:test@localhost:5432/firsttree");
    vi.stubEnv("FIRST_TREE_JWT_SECRET", "operator-jwt-secret");
    vi.stubEnv("FIRST_TREE_ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    vi.stubEnv("FIRST_TREE_RATE_LIMIT_LOGIN_MAX", "9999");
    vi.stubEnv("FIRST_TREE_RATE_LIMIT_WEBHOOK_MAX", "9999");
    vi.stubEnv("FIRST_TREE_RATE_LIMIT_AGENT_MESSAGE_MAX", "9999");
    vi.stubEnv("FIRST_TREE_RATE_LIMIT_CONTEXT_TREE_SNAPSHOT_MAX", "9999");

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.rateLimit).toBeUndefined();
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
