import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const installClientServiceMock = vi.hoisted(() => vi.fn());
const isServiceSupportedMock = vi.hoisted(() => vi.fn());
const cleanupStaleLocalAliasesMock = vi.hoisted(() => vi.fn());
const selectMock = vi.hoisted(() => vi.fn());
const clientRuntimeMock = vi.hoisted(() => vi.fn());
const createApiNameResolverMock = vi.hoisted(() => vi.fn());
const createExecuteUpdateMock = vi.hoisted(() => vi.fn());
const ensureFreshAccessTokenMock = vi.hoisted(() => vi.fn());
const handleClientOrgMismatchMock = vi.hoisted(() => vi.fn());
const migrateLocalAgentDirsMock = vi.hoisted(() => vi.fn());
const promptUpdateMock = vi.hoisted(() => vi.fn());
const stderrMock = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
const exitMock = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as never);

vi.mock("../core/cli-fetch.js", () => ({
  cliFetch: cliFetchMock,
}));

vi.mock("../core/service-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/service-install.js")>()),
  installClientService: installClientServiceMock,
  isServiceSupported: isServiceSupportedMock,
}));

vi.mock("../core/client-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client-runtime.js")>()),
  ClientRuntime: clientRuntimeMock,
}));

vi.mock("../core/migrate-agent-dirs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/migrate-agent-dirs.js")>()),
  createApiNameResolver: createApiNameResolverMock,
  migrateLocalAgentDirs: migrateLocalAgentDirsMock,
}));

vi.mock("../core/bootstrap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/bootstrap.js")>()),
  ensureFreshAccessToken: ensureFreshAccessTokenMock,
}));

vi.mock("../core/client-reidentify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/client-reidentify.js")>()),
  handleClientOrgMismatch: handleClientOrgMismatchMock,
}));

vi.mock("../core/update-glue.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../core/update-glue.js")>()),
  createExecuteUpdate: createExecuteUpdateMock,
  promptUpdate: promptUpdateMock,
}));

vi.mock("../commands/_shared/account-transfer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/_shared/account-transfer.js")>()),
  cleanupStaleLocalAliases: cleanupStaleLocalAliasesMock,
}));

vi.mock("@inquirer/prompts", () => ({
  select: selectMock,
}));

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;

let home: string;
let runtimeInstance: {
  addAgent: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  unwatchAgentsDir: ReturnType<typeof vi.fn>;
  watchAgentsDir: ReturnType<typeof vi.fn>;
};

function jwt(payload: Record<string, unknown>): string {
  return `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function runLogin(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const { registerLoginCommand } = await import("../commands/login.js");
  registerLoginCommand(program);
  await program.parseAsync(args, { from: "user" });
}

function credentialsPath(): string {
  return join(home, "config", "credentials.json");
}

function writeCredentials(memberId: string, serverUrl = "http://old.test", sub = "user-old"): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    credentialsPath(),
    JSON.stringify({
      accessToken: jwt({ sub, memberId, exp: Math.floor(Date.now() / 1000) + 3600 }),
      refreshToken: "old-refresh",
      serverUrl,
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  home = join(tmpdir(), `ft-login-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  delete process.env.FIRST_TREE_SERVER_URL;
  cliFetchMock.mockReset();
  installClientServiceMock.mockReset();
  isServiceSupportedMock.mockReset();
  cleanupStaleLocalAliasesMock.mockReset();
  selectMock.mockReset();
  clientRuntimeMock.mockReset();
  createApiNameResolverMock.mockReset();
  createExecuteUpdateMock.mockReset();
  ensureFreshAccessTokenMock.mockReset();
  handleClientOrgMismatchMock.mockReset();
  migrateLocalAgentDirsMock.mockReset();
  promptUpdateMock.mockReset();
  stderrMock.mockClear();
  exitMock.mockClear();
  process.exitCode = undefined;
  cliFetchMock.mockImplementation(async () =>
    response(200, { accessToken: jwt({ sub: "user-new", memberId: "member-new" }), refreshToken: "r1" }),
  );
  isServiceSupportedMock.mockReturnValue(false);
  createApiNameResolverMock.mockReturnValue({ resolveName: vi.fn(async () => "nova") });
  createExecuteUpdateMock.mockReturnValue(async () => undefined);
  ensureFreshAccessTokenMock.mockResolvedValue("access-token");
  migrateLocalAgentDirsMock.mockResolvedValue({ scanned: 0, renamed: 0, skipped: 0, errors: 0 });
  runtimeInstance = {
    addAgent: vi.fn(),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    unwatchAgentsDir: vi.fn(),
    watchAgentsDir: vi.fn(() => {
      throw new Error("stop after watch");
    }),
  };
  clientRuntimeMock.mockImplementation(() => runtimeInstance);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  process.exitCode = undefined;
});

// `runLogin` dynamic-imports `commands/login.js` on every test run, which
// pulls in the credentials / config / runtime module graph fresh each time.
// On hot caches that resolves in ~500 ms; on cold CI runners it has been
// observed hitting ~5 s (vitest's default `testTimeout`). The tests do not
// drive long-running work themselves, so the 5 s default is too tight for
// CI's first-load cost — bump to 15 s across the describe to give cold
// caches headroom without affecting hot-run latency.
describe("login command", { timeout: 15_000 }, () => {
  it("exchanges a connect token, writes credentials/config, and honors --no-start", async () => {
    await runLogin(["login", jwt({ iss: "http://first-tree.test/", memberId: "member-new" }), "--no-start"]);

    expect(cliFetchMock).toHaveBeenCalledWith(
      "http://first-tree.test/api/v1/auth/connect-token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(readFileSync(credentialsPath(), "utf8"))).toMatchObject({
      refreshToken: "r1",
      serverUrl: "http://first-tree.test",
    });
    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toContain("url: http://first-tree.test");
    expect(installClientServiceMock).not.toHaveBeenCalled();
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("--no-start");
  });

  it("prompts before replacing a different local account", async () => {
    writeCredentials("member-old");
    selectMock.mockResolvedValueOnce("cancel");

    await runLogin(["login", jwt({ iss: "http://first-tree.test", memberId: "member-new" })]);

    expect(selectMock).toHaveBeenCalled();
    expect(cliFetchMock).not.toHaveBeenCalled();
    expect(readFileSync(credentialsPath(), "utf8")).toContain("old-refresh");
  });

  it("cross-account override rotates the local client identity and starts supported services", async () => {
    // Pre-existing machine identity + credentials owned by a DIFFERENT user.
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");
    cleanupStaleLocalAliasesMock.mockResolvedValueOnce(undefined);
    isServiceSupportedMock.mockReturnValueOnce(true);
    installClientServiceMock.mockReturnValueOnce({ platform: "launchd", logDir: join(home, "logs") });

    // Incoming token belongs to user-new (default mock) — a real handover.
    await runLogin(["login", jwt({ iss: "http://first-tree.test", memberId: "member-new" }), "--override"]);

    // Fresh identity written, old one preserved in the backup.
    const rotatedYaml = readFileSync(yamlPath, "utf8");
    expect(rotatedYaml).not.toContain("client_aabbccdd");
    expect(rotatedYaml).toMatch(/id: client_[a-f0-9]{8}/);
    expect(readFileSync(join(home, "config", "client.yaml.bak"), "utf8")).toContain("client_aabbccdd");

    expect(cleanupStaleLocalAliasesMock).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "http://first-tree.test", nonInteractive: true }),
    );
    expect(installClientServiceMock).toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Rotated local client identity");
  });

  it("same-account override is idempotent: no rotation, no destructive alias cleanup", async () => {
    // Pre-existing identity + credentials owned by the SAME user as the
    // incoming token (sub "user-new"). Re-running `login --override` here is a
    // reauth/retry, not a handover — it must NOT abandon the clientId (which
    // would orphan the server row and prune our own local agent mirrors).
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-new", "http://first-tree.test", "user-new");
    isServiceSupportedMock.mockReturnValueOnce(true);
    installClientServiceMock.mockReturnValueOnce({ platform: "launchd", logDir: join(home, "logs") });

    await runLogin(["login", jwt({ iss: "http://first-tree.test", memberId: "member-new" }), "--override"]);

    // clientId preserved, no backup, no rotation message.
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(existsSync(join(home, "config", "client.yaml.bak"))).toBe(false);
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).not.toContain("Rotated local client identity");
    // Stale-alias cleanup is rotation-gated, so it must not run.
    expect(cleanupStaleLocalAliasesMock).not.toHaveBeenCalled();
  });

  it("override mode on a fresh machine skips rotation (nothing to abandon)", async () => {
    cleanupStaleLocalAliasesMock.mockResolvedValueOnce(undefined);
    isServiceSupportedMock.mockReturnValueOnce(true);
    installClientServiceMock.mockReturnValueOnce({ platform: "launchd", logDir: join(home, "logs") });

    await runLogin(["login", jwt({ iss: "http://first-tree.test", memberId: "member-new" }), "--override"]);

    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).not.toContain("Rotated local client identity");
    expect(readFileSync(join(home, "config", "client.yaml"), "utf8")).toMatch(/id: client_[a-f0-9]{8}/);
  });

  it("maps invalid tokens and token exchange failures to CLI errors", async () => {
    await expect(runLogin(["login", "not-a-jwt"])).rejects.toThrow("process.exit");
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("INVALID_TOKEN");

    stderrMock.mockClear();
    exitMock.mockClear();
    cliFetchMock.mockResolvedValueOnce(response(403, { error: "expired token" }));
    await expect(
      runLogin(["login", jwt({ iss: "http://first-tree.test", memberId: "member-new" }), "--no-start"]),
    ).rejects.toThrow("process.exit");
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("expired token");
  });

  it("falls back to inline runtime when service install is unsupported", async () => {
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");

    await expect(runLogin(["login", jwt({ iss: "http://hub.test", memberId: "member-new" })])).rejects.toThrow(
      "process.exit",
    );

    expect(migrateLocalAgentDirsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentsDir: join(home, "config", "agents"),
        sessionsDir: join(home, "data", "sessions"),
        workspacesDir: join(home, "data", "workspaces"),
      }),
    );
    expect(clientRuntimeMock).toHaveBeenCalledWith(
      "http://hub.test",
      expect.any(String),
      expect.objectContaining({
        update: expect.objectContaining({
          executeUpdate: expect.any(Function),
          prompt: promptUpdateMock,
        }),
      }),
    );
    expect(runtimeInstance.addAgent).toHaveBeenCalledWith("nova", expect.objectContaining({ agentId: "agent-1" }));
    expect(runtimeInstance.start).toHaveBeenCalled();
    expect(runtimeInstance.watchAgentsDir).toHaveBeenCalledWith(join(home, "config", "agents"));
    const text = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(text).toContain("Background service not supported");
    expect(text).toContain("Error: stop after watch");
  });

  it("continues inline fallback when migration fails and handles prompt/org errors", async () => {
    mkdirSync(join(home, "config", "agents"), { recursive: true });
    migrateLocalAgentDirsMock.mockRejectedValueOnce(new Error("offline"));

    await expect(runLogin(["login", jwt({ iss: "http://hub.test", memberId: "member-new" })])).rejects.toThrow(
      "process.exit",
    );
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "agent-dir migration skipped: offline",
    );

    stderrMock.mockClear();
    exitMock.mockClear();
    const client = await import("@first-tree/client");
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientOrgMismatchError("wrong org"));
    await expect(runLogin(["login", jwt({ iss: "http://hub.test", memberId: "member-new" })])).rejects.toThrow(
      "process.exit",
    );
    expect(handleClientOrgMismatchMock).toHaveBeenCalledWith(
      expect.any(client.ClientOrgMismatchError),
      expect.objectContaining({ managed: false, rerunCommand: "first-tree-dev login <token>" }),
    );

    stderrMock.mockClear();
    exitMock.mockClear();
    writeCredentials("member-old");
    selectMock.mockRejectedValueOnce(Object.assign(new Error("prompt closed"), { name: "ExitPromptError" }));
    await runLogin(["login", jwt({ iss: "http://hub.test", memberId: "member-new" })]);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Cancelled.");
  });
});
