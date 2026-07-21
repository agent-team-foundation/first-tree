import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initConfig, resolveConfigReadonly } from "../resolver.js";
import {
  browserSecurityConnectOriginListConfigSchema,
  browserSecurityOriginListConfigSchema,
  createServerConfigSchema,
  getServerConfig,
  serverConfigSchema,
} from "../server-config.js";
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
    expect(fieldSchema.parse(undefined)).toBeUndefined();
  });

  it("materializes empty browser CSP origin lists with no env or YAML input", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.security.csp).toEqual({
      scriptOrigins: [],
      connectOrigins: [],
      imageOrigins: [],
    });
    expect(resolveConfigReadonly({ schema: serverConfigSchema, role: "server", configDir })).toMatchObject({
      security: {
        csp: {
          scriptOrigins: [],
          connectOrigins: [],
          imageOrigins: [],
        },
      },
    });
  });

  it("canonicalizes, deduplicates, and sorts browser CSP origins from CSV and YAML", async () => {
    expect(
      browserSecurityOriginListConfigSchema.parse(" HTTPS://Z.EXAMPLE:443/,https://a.example,https://z.example "),
    ).toEqual(["https://a.example", "https://z.example"]);
    expect(
      browserSecurityConnectOriginListConfigSchema.parse(
        "WSS://SOCKET.EXAMPLE:443/,https://api.example,wss://socket.example",
      ),
    ).toEqual(["https://api.example", "wss://socket.example"]);
    expect(browserSecurityOriginListConfigSchema.parse("https://cdn.example:8443/")).toEqual([
      "https://cdn.example:8443",
    ]);
    expect(browserSecurityOriginListConfigSchema.safeParse("wss://socket.example").success).toBe(false);

    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    writeFileSync(
      join(configDir, "server.yaml"),
      "security:\n  csp:\n    imageOrigins:\n      - https://images.example/\n      - https://avatars.example\n",
    );
    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });
    expect(config.security.csp.imageOrigins).toEqual(["https://avatars.example", "https://images.example"]);
  });

  it("rejects CSP inputs that only become origins after URL normalization", () => {
    const invalidOrigins = [
      "https://cdn.example/private/..",
      "https://cdn.example?",
      "https://cdn.example#",
      "https://%63dn.example",
      "https://127.1",
      "https://K.com",
    ];

    for (const origin of invalidOrigins) {
      expect(browserSecurityOriginListConfigSchema.safeParse(origin).success).toBe(false);
      expect(browserSecurityConnectOriginListConfigSchema.safeParse(origin).success).toBe(false);
    }
  });

  it("rejects and redacts a CSP-delimiter authority from CSV environment input", async () => {
    const configDir = makeTempConfigDir();
    const rejected = "https://safe.example,https://cdn.example;upgrade-insecure-requests";
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_CSP_SCRIPT_ORIGINS", rejected);

    let message = "";
    try {
      await initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("security.csp.scriptOrigins");
    expect(message).not.toContain(rejected);
    expect(message).not.toContain("upgrade-insecure-requests");
  });

  it("rejects and redacts a CSP-delimiter authority from a YAML array", async () => {
    const configDir = makeTempConfigDir();
    const rejected = "https://cdn.example,upgrade-insecure-requests";
    stubRequiredProductionConfig();
    writeFileSync(join(configDir, "server.yaml"), `security:\n  csp:\n    imageOrigins:\n      - "${rejected}"\n`);

    let message = "";
    try {
      await initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("security.csp.imageOrigins");
    expect(message).not.toContain(rejected);
    expect(message).not.toContain("upgrade-insecure-requests");
  });

  it("rejects non-origin CSP input without reflecting the rejected value", async () => {
    const configDir = makeTempConfigDir();
    const rejected = "https://user:super-secret@example.com/path?token=secret";
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_CSP_CONNECT_ORIGINS", rejected);

    let message = "";
    try {
      await initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("security.csp.connectOrigins");
    expect(message).not.toContain(rejected);
    expect(message).not.toContain("super-secret");
  });

  it("loads Google OAuth only when both credentials are configured", async () => {
    const missingDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    const missing = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: missingDir,
    });
    expect(missing.oauth?.google).toBeUndefined();

    resetConfig();
    const configuredDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_GOOGLE_CLIENT_ID", "google-client-id");
    vi.stubEnv("FIRST_TREE_GOOGLE_CLIENT_SECRET", "google-client-secret");
    const configured = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: configuredDir,
    });
    expect(configured.oauth?.google).toEqual({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
  });

  it("rejects partial Google OAuth configuration", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_GOOGLE_CLIENT_ID", "google-client-id");
    await expect(
      initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      }),
    ).rejects.toThrow(/clientSecret/);
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
    expect(defaultConfig.growth.landingCampaignMaxAgentTurns).toBe(6);
    expect(defaultConfig.growth.landingCampaignMaxEstimatedTokens).toBe(120_000);
    expect(defaultConfig.growth.landingCampaignMaxTrialsPerUserPer24Hours).toBe(5);

    resetConfig();
    const enabledConfigDir = makeTempConfigDir();
    vi.stubEnv("FIRST_TREE_GROWTH_LANDING_PAGES_ENABLED", "true");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_MAX_AGENT_TURNS", "4");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_MAX_ESTIMATED_TOKENS", "12000");
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_MAX_TRIALS_PER_USER_PER_24_HOURS", "7");

    const enabledConfig = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: enabledConfigDir,
    });

    expect(enabledConfig.growth.landingPagesEnabled).toBe(true);
    expect(enabledConfig.growth.landingCampaignMaxAgentTurns).toBe(4);
    expect(enabledConfig.growth.landingCampaignMaxEstimatedTokens).toBe(12000);
    expect(enabledConfig.growth.landingCampaignMaxTrialsPerUserPer24Hours).toBe(7);
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

  it("rejects invalid landing campaign estimated token limits", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_MAX_ESTIMATED_TOKENS", "0");

    await expect(
      initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      }),
    ).rejects.toThrow(/landingCampaignMaxEstimatedTokens/);
  });

  it("rejects invalid landing campaign trial quota limits", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_LANDING_CAMPAIGN_MAX_TRIALS_PER_USER_PER_24_HOURS", "0");

    await expect(
      initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      }),
    ).rejects.toThrow(/landingCampaignMaxTrialsPerUserPer24Hours/);
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

  it("ignores the removed bootstrap method env and resolves the portable base URL", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_CONNECT_BOOTSTRAP_METHOD", "npm");
    vi.stubEnv("FIRST_TREE_PORTABLE_DOWNLOAD_BASE_URL", "https://downloads.example.test");

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.connectBootstrap).toEqual({
      portableDownloadBaseUrl: "https://downloads.example.test",
    });
    expect(serverConfigSchema.connectBootstrap).not.toHaveProperty("method");
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
