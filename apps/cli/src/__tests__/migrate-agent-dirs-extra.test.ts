import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NameResolver } from "../core/migrate-agent-dirs.js";

const cliFetchMock = vi.hoisted(() => vi.fn());
const printMock = vi.hoisted(() => ({ status: vi.fn() }));

vi.mock("../core/cli-fetch.js", () => ({ cliFetch: cliFetchMock }));
vi.mock("../core/output.js", () => ({ print: printMock }));

let root = "";
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function dirs() {
  return {
    agentsDir: join(root, "config", "agents"),
    workspacesDir: join(root, "data", "workspaces"),
    sessionsDir: join(root, "data", "sessions"),
  };
}

function writeAgentYaml(name: string, agentId: string): void {
  const dir = join(root, "config", "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), `agentId: ${agentId}\nruntime: claude-code\n`);
}

function writeWorkspace(name: string): void {
  mkdirSync(join(root, "data", "workspaces", name), { recursive: true });
}

function writeSession(name: string): void {
  mkdirSync(join(root, "data", "sessions"), { recursive: true });
  writeFileSync(join(root, "data", "sessions", `${name}.json`), "{}\n");
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  root = makeTempDir("ft-migrate-extra-");
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("createApiNameResolver", () => {
  it("fetches managed agent names once, caches the listing, and maps missing names to null", async () => {
    const { createApiNameResolver } = await import("../core/migrate-agent-dirs.js");
    cliFetchMock.mockResolvedValueOnce(
      jsonResponse([
        { uuid: "agent-1", name: "alice" },
        { uuid: "agent-2", name: null },
      ]),
    );
    const getAccessToken = vi.fn(async () => "access-token");
    const resolver = createApiNameResolver("https://hub.example", getAccessToken);

    await expect(resolver.resolveName("agent-1")).resolves.toBe("alice");
    await expect(resolver.resolveName("agent-2")).resolves.toBeNull();
    await expect(resolver.resolveName("agent-3")).resolves.toBeNull();

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(cliFetchMock).toHaveBeenCalledTimes(1);
    expect(cliFetchMock).toHaveBeenCalledWith(
      "https://hub.example/api/v1/me/managed-agents",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer access-token" },
      }),
    );
  });

  it("throws when the managed-agent fetch fails", async () => {
    const { createApiNameResolver } = await import("../core/migrate-agent-dirs.js");
    cliFetchMock.mockResolvedValueOnce(jsonResponse({ error: "forbidden" }, false, 403));
    const resolver = createApiNameResolver("https://hub.example", async () => "token");

    await expect(resolver.resolveName("agent-1")).rejects.toThrow("/me/managed-agents returned HTTP 403");
  });
});

describe("migrateLocalAgentDirs extra failure branches", () => {
  it("routes migration status through an injected logger", async () => {
    const { migrateLocalAgentDirs } = await import("../core/migrate-agent-dirs.js");
    writeAgentYaml("old", "agent-1");
    const log = vi.fn();

    const result = await migrateLocalAgentDirs({
      ...dirs(),
      resolver: { resolveName: vi.fn(async () => "new") },
      log,
    });

    expect(result).toMatchObject({ renamed: 1, errors: 0 });
    expect(log).toHaveBeenCalledWith("", 'agent "old" renamed to "new" to match server');
    expect(printMock.status).not.toHaveBeenCalled();
  });

  it("records an enumeration error without throwing", async () => {
    const { migrateLocalAgentDirs } = await import("../core/migrate-agent-dirs.js");
    const agentsDir = join(root, "config", "agents");
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(agentsDir, "not a directory\n");

    const result = await migrateLocalAgentDirs({
      ...dirs(),
      resolver: { resolveName: vi.fn(async () => "alice") },
    });

    expect(result).toEqual({ scanned: 0, renamed: 0, skipped: 0, errors: 1 });
    expect(printMock.status).toHaveBeenCalledWith("⚠️", expect.stringContaining("unable to enumerate"));
  });

  it("skips non-directory entries and malformed agent ids", async () => {
    const { migrateLocalAgentDirs } = await import("../core/migrate-agent-dirs.js");
    mkdirSync(join(root, "config", "agents"), { recursive: true });
    writeFileSync(join(root, "config", "agents", "plain-file"), "");
    mkdirSync(join(root, "config", "agents", "empty"), { recursive: true });
    writeFileSync(join(root, "config", "agents", "empty", "agent.yaml"), "runtime: claude-code\n");
    writeAgentYaml("old", "agent-1");

    const result = await migrateLocalAgentDirs({
      ...dirs(),
      resolver: { resolveName: vi.fn(async () => "new") },
    });

    expect(result).toMatchObject({ scanned: 1, renamed: 1, errors: 1 });
    expect(readdirSync(join(root, "config", "agents")).sort()).toEqual(["empty", "new", "plain-file"]);
  });

  it("continues after config, workspace, and session rename edge cases", async () => {
    const { migrateLocalAgentDirs } = await import("../core/migrate-agent-dirs.js");
    writeAgentYaml("config-fail", "agent-config-fail");
    writeAgentYaml("workspace-file", "agent-workspace-file");
    writeAgentYaml("session-collision", "agent-session-collision");
    writeWorkspace("workspace-file");
    writeSession("session-collision");
    writeSession("session-target");
    writeFileSync(join(root, "data", "workspaces", "workspace-target"), "not a directory\n");

    const resolver: NameResolver = {
      async resolveName(agentId) {
        return (
          (
            {
              "agent-config-fail": "blocked/name",
              "agent-workspace-file": "workspace-target",
              "agent-session-collision": "session-target",
            } satisfies Record<string, string>
          )[agentId] ?? null
        );
      },
    };

    const result = await migrateLocalAgentDirs({ ...dirs(), resolver });

    expect(result).toMatchObject({ scanned: 3, renamed: 2, errors: 1 });
    expect(printMock.status).toHaveBeenCalledWith(
      "⚠️",
      expect.stringContaining('config dir rename failed for "config-fail"'),
    );
    expect(printMock.status).toHaveBeenCalledWith(
      "⚠️",
      expect.stringContaining('workspace target "workspace-target" already exists'),
    );
    expect(printMock.status).toHaveBeenCalledWith(
      "⚠️",
      expect.stringContaining('sessions target "session-target.json" already exists'),
    );
  });
});
