import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const installClientServiceMock = vi.hoisted(() => vi.fn());
const isServiceSupportedMock = vi.hoisted(() => vi.fn());
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

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;
const originalStdinIsTTY = process.stdin.isTTY;

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

function setStdinIsTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value });
}

beforeEach(() => {
  vi.resetModules();
  home = join(tmpdir(), `ft-login-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(home, "config"), { recursive: true });
  process.env.FIRST_TREE_HOME = home;
  setStdinIsTTY(false);
  delete process.env.FIRST_TREE_SERVER_URL;
  cliFetchMock.mockReset();
  installClientServiceMock.mockReset();
  isServiceSupportedMock.mockReset();
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
    response(200, { accessToken: jwt({ sub: "user-new" }), refreshToken: "r1" }),
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
  setStdinIsTTY(originalStdinIsTTY);
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
    await runLogin(["login", jwt({ iss: "http://first-tree.test/" }), "--no-start"]);

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

  it("requires --force-switch for non-interactive cross-account login before overwriting local credentials", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");

    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );

    expect(cliFetchMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(credentialsPath(), "utf8")).toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(installClientServiceMock).not.toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("CLIENT_SWITCH_REQUIRES_FORCE_SWITCH");
    expect(output).toContain("first-tree-dev login <token> --force-switch");
    expect(output).toContain("may stop the current daemon, agents, and provider turn");
  });

  it("accepts --force-switch as interrupt authorization but still refuses the unimplemented root-state switch", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-old", "http://first-tree.test", "user-old");

    await expect(
      runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--force-switch", "--no-start"]),
    ).rejects.toThrow("process.exit");

    expect(cliFetchMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(credentialsPath(), "utf8")).toContain("old-refresh");
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(installClientServiceMock).not.toHaveBeenCalled();
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("CLIENT_SWITCH_NOT_IMPLEMENTED");
    expect(output).toContain("authorized by --force-switch");
    expect(output).toContain("new First Tree user must receive a separate");
    expect(output).toContain("Safety gates are not bypassed by --force-switch");
  });

  it("allows same-user reauth without rotating the client identity", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    writeCredentials("member-new", "http://first-tree.test", "user-new");

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"]);

    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    expect(existsSync(join(home, "config", "client.yaml.bak"))).toBe(false);
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Authenticated");
    expect(output).not.toContain("ACCOUNT_SWITCH_REQUIRES_PURGE");
  });

  it("allows reconnect with preserved client identity and local agent state when credentials are missing", async () => {
    const yamlPath = join(home, "config", "client.yaml");
    writeFileSync(yamlPath, "client:\n  id: client_aabbccdd\n");
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");

    await runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"]);

    expect(cliFetchMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(yamlPath, "utf8")).toContain("client_aabbccdd");
    const output = stderrMock.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Authenticated");
    expect(output).not.toContain("ACCOUNT_SWITCH_REQUIRES_PURGE");
  });

  it("maps invalid tokens and token exchange failures to CLI errors", async () => {
    await expect(runLogin(["login", "not-a-jwt"])).rejects.toThrow("process.exit");
    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("INVALID_TOKEN");

    stderrMock.mockClear();
    exitMock.mockClear();
    cliFetchMock.mockResolvedValueOnce(response(403, { error: "expired token" }));
    await expect(runLogin(["login", jwt({ iss: "http://first-tree.test" }), "--no-start"])).rejects.toThrow(
      "process.exit",
    );
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("expired token");
  });

  it("falls back to inline runtime when service install is unsupported", async () => {
    writeCredentials("member-new", "http://hub.test", "user-new");
    mkdirSync(join(home, "config", "agents", "nova"), { recursive: true });
    writeFileSync(join(home, "config", "agents", "nova", "agent.yaml"), "agentId: agent-1\nruntime: claude-code\n");

    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");

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

    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "agent-dir migration skipped: offline",
    );

    stderrMock.mockClear();
    exitMock.mockClear();
    const client = await import("@first-tree/client");
    runtimeInstance.start.mockRejectedValueOnce(new client.ClientOrgMismatchError("wrong org"));
    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");
    expect(handleClientOrgMismatchMock).toHaveBeenCalledWith(
      expect.any(client.ClientOrgMismatchError),
      expect.objectContaining({ managed: false, rerunCommand: "first-tree-dev login <token>" }),
    );

    stderrMock.mockClear();
    exitMock.mockClear();
    writeCredentials("member-old");
    await expect(runLogin(["login", jwt({ iss: "http://hub.test" })])).rejects.toThrow("process.exit");
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "CLIENT_SWITCH_REQUIRES_FORCE_SWITCH",
    );
  });
});
