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
    expect(fieldSchema.parse(undefined)).toBeUndefined();
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

  it("loads the deployment GitLab egress allowlist from operator JSON and defaults to deny", async () => {
    const defaultDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    const denied = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: defaultDir,
    });
    expect(denied.gitlab).toBeUndefined();

    resetConfig();
    const configuredDir = makeTempConfigDir();
    vi.stubEnv(
      "FIRST_TREE_GITLAB_EGRESS_ALLOWLIST",
      JSON.stringify([
        {
          origin: "https://GITLAB.COMPANY.LOCAL:8443",
          addressPolicy: { kind: "cidrs", cidrs: ["10.20.0.0/16"] },
        },
      ]),
    );
    const configured = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir: configuredDir,
    });
    expect(configured.gitlab?.egressAllowlist).toEqual([
      {
        origin: "https://gitlab.company.local:8443",
        addressPolicy: { kind: "cidrs", cidrs: ["10.20.0.0/16"] },
      },
    ]);
  });

  it("rejects malformed GitLab egress allowlist JSON during config initialization", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv("FIRST_TREE_GITLAB_EGRESS_ALLOWLIST", "not-json");
    await expect(
      initConfig({
        schema: createServerConfigSchema({ autoGenerateSecrets: false }),
        role: "server",
        configDir,
      }),
    ).rejects.toThrow(/gitlab|array/iu);
  });

  it("loads exact CSP origins from comma-separated deployment config", async () => {
    const configDir = makeTempConfigDir();
    stubRequiredProductionConfig();
    vi.stubEnv(
      "FIRST_TREE_CSP_SCRIPT_ORIGINS",
      " https://www.googletagmanager.com,https://www.clarity.ms,https://www.clarity.ms ",
    );
    vi.stubEnv("FIRST_TREE_CSP_CONNECT_ORIGINS", "https://www.google-analytics.com,https://c.clarity.ms");
    vi.stubEnv("FIRST_TREE_CSP_IMAGE_ORIGINS", "https://AVATARS.GITHUBUSERCONTENT.COM");

    const config = await initConfig({
      schema: createServerConfigSchema({ autoGenerateSecrets: false }),
      role: "server",
      configDir,
    });

    expect(config.security?.csp).toEqual({
      scriptOrigins: ["https://www.googletagmanager.com", "https://www.clarity.ms"],
      connectOrigins: ["https://www.google-analytics.com", "https://c.clarity.ms"],
      imageOrigins: ["https://avatars.githubusercontent.com"],
    });
  });

  it("rejects wildcard and path-based CSP sources", () => {
    const schema = serverConfigSchema.security.shape.csp.scriptOrigins.schema;
    expect(() => schema.parse("https://*.clarity.ms")).toThrow(/exact credential-free HTTP\(S\) origins/);
    expect(() => schema.parse("https://cdn.example.com/assets")).toThrow(/exact credential-free HTTP\(S\) origins/);
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
