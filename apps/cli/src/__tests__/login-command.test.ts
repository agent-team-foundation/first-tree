import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cliFetchMock = vi.hoisted(() => vi.fn());
const installClientServiceMock = vi.hoisted(() => vi.fn());
const isServiceSupportedMock = vi.hoisted(() => vi.fn());
const postClaimMock = vi.hoisted(() => vi.fn());
const cleanupStaleAliasesAfterClaimMock = vi.hoisted(() => vi.fn());
const selectMock = vi.hoisted(() => vi.fn());
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

vi.mock("../commands/_shared/account-transfer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/_shared/account-transfer.js")>()),
  cleanupStaleAliasesAfterClaim: cleanupStaleAliasesAfterClaimMock,
  postClaim: postClaimMock,
}));

vi.mock("@inquirer/prompts", () => ({
  select: selectMock,
}));

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalServerUrl = process.env.FIRST_TREE_SERVER_URL;

let home: string;

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

function writeCredentials(memberId: string, serverUrl = "http://old.test"): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    credentialsPath(),
    JSON.stringify({
      accessToken: jwt({ memberId, exp: Math.floor(Date.now() / 1000) + 3600 }),
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
  postClaimMock.mockReset();
  cleanupStaleAliasesAfterClaimMock.mockReset();
  selectMock.mockReset();
  stderrMock.mockClear();
  exitMock.mockClear();
  process.exitCode = undefined;
  cliFetchMock.mockResolvedValue(response(200, { accessToken: jwt({ memberId: "member-new" }), refreshToken: "r1" }));
  isServiceSupportedMock.mockReturnValue(false);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalServerUrl === undefined) delete process.env.FIRST_TREE_SERVER_URL;
  else process.env.FIRST_TREE_SERVER_URL = originalServerUrl;
  process.exitCode = undefined;
});

describe("login command", () => {
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

  it("transfers ownership in override mode and starts supported services", async () => {
    postClaimMock.mockResolvedValueOnce({ clientId: "client-1", previousUserId: "old", unpinnedAgentCount: 2 });
    cleanupStaleAliasesAfterClaimMock.mockResolvedValueOnce(undefined);
    isServiceSupportedMock.mockReturnValueOnce(true);
    installClientServiceMock.mockReturnValueOnce({ platform: "launchd", logDir: join(home, "logs") });

    await runLogin(["login", jwt({ iss: "http://first-tree.test", memberId: "member-new" }), "--override"]);

    expect(postClaimMock).toHaveBeenCalledWith("http://first-tree.test", expect.any(String));
    expect(cleanupStaleAliasesAfterClaimMock).toHaveBeenCalledWith(
      expect.objectContaining({ serverUrl: "http://first-tree.test", nonInteractive: true }),
    );
    expect(installClientServiceMock).toHaveBeenCalled();
    expect(stderrMock.mock.calls.map((call) => String(call[0])).join("")).toContain("Ownership transferred");
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
});
