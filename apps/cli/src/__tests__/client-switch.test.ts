import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectSwitchDrainProcessFromEnvText,
  ensureActiveRootClientIdPersisted,
  isSwitchDrainEnvRequired,
  listLiveClientRuntimeMarkers,
  parseSwitchProcessEnvValue,
  readActiveClientIdFromIndex,
  stopClientRuntimeProcess,
} from "../core/client-switch.js";

const children: ChildProcess[] = [];
const tempHomes: string[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
  for (const home of tempHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("client switch drain markers", () => {
  it("preserves spaces inside NUL-delimited process environment values", () => {
    const envText = [
      "FIRST_TREE_PROVIDER=codex",
      "FIRST_TREE_HOME=/Users/Alice Smith/.first-tree",
      "FIRST_TREE_CLIENT_ID=client_aabbccdd",
      "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
      "",
    ].join("\0");

    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_HOME")).toBe("/Users/Alice Smith/.first-tree");
    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_CLIENT_ID")).toBe("client_aabbccdd");
  });

  it("keeps whitespace-delimited process text parsing for ps output", () => {
    const envText = "FIRST_TREE_HOME=/Users/alice/.first-tree FIRST_TREE_CLIENT_ID=client_aabbccdd /usr/bin/codex";

    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_HOME")).toBe("/Users/alice/.first-tree");
    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_CLIENT_ID")).toBe("client_aabbccdd");
  });

  it("preserves spaces inside process text values when another env marker follows", () => {
    const envText =
      "FIRST_TREE_PROVIDER=codex FIRST_TREE_HOME=/Users/Alice Smith/.first-tree FIRST_TREE_CLIENT_ID=client_aabbccdd";

    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_HOME")).toBe("/Users/Alice Smith/.first-tree");
    expect(parseSwitchProcessEnvValue(envText, "FIRST_TREE_PROVIDER")).toBe("codex");
  });

  it("treats unknown commands with trusted switch markers as live descendants", () => {
    const providers: Array<{ pid: number; provider: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];
    const envText = [
      "FIRST_TREE_HOME=/Users/alice/.first-tree",
      "FIRST_TREE_CLIENT_ID=client_aabbccdd",
      "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
      "",
    ].join("\0");

    collectSwitchDrainProcessFromEnvText({
      pid: 123,
      command: "/bin/bash ./provider-child",
      envText,
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(issues).toEqual([]);
    expect(providers).toEqual([
      expect.objectContaining({ pid: 123, provider: "marked-descendant", command: "/bin/bash ./provider-child" }),
    ]);
  });

  it("fails closed on unknown marked descendants without trusted drain version", () => {
    const providers: Array<{ pid: number; provider: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];
    const envText = ["FIRST_TREE_HOME=/Users/alice/.first-tree", "FIRST_TREE_CLIENT_ID=client_aabbccdd", ""].join("\0");

    collectSwitchDrainProcessFromEnvText({
      pid: 124,
      command: "node worker.js",
      envText,
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(providers).toEqual([]);
    expect(issues).toEqual([expect.objectContaining({ pid: 124, reason: "missing trusted switch drain markers" })]);
  });

  it("requires readable env only for known switch-drain process commands", () => {
    expect(isSwitchDrainEnvRequired("/usr/bin/codex exec")).toBe(true);
    expect(isSwitchDrainEnvRequired("node cli/index.mjs daemon start --foreground")).toBe(true);
    expect(isSwitchDrainEnvRequired("/bin/bash unrelated-script")).toBe(false);
  });
});

describe("client runtime markers", () => {
  it("cleans stale runtime markers while listing live runtimes", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-runtime-markers-"));
    tempHomes.push(home);
    const markerDir = join(home, "state", "client-runtimes");
    const markerPath = join(markerDir, "-1.json");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({
        version: 1,
        pid: -1,
        clientId: "client-1",
        home,
        mode: "foreground",
        createdAt: new Date().toISOString(),
      }),
    );

    expect(listLiveClientRuntimeMarkers(home, "client-1")).toEqual([]);
    expect(existsSync(markerPath)).toBe(false);
  });

  it("sends SIGTERM and waits for a live runtime process to exit", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);",
    ]);
    children.push(child);
    expect(child.pid).toEqual(expect.any(Number));

    const res = await stopClientRuntimeProcess(child.pid ?? -1, { timeoutMs: 5_000, intervalMs: 25 });

    expect(res).toEqual({ ok: true });
  });
});

describe("active client identity recovery", () => {
  it("reads only active-root client ids from the switch index", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-active-index-"));
    tempHomes.push(home);
    mkdirSync(join(home, "parked-clients"), { recursive: true });
    writeFileSync(
      join(home, "parked-clients", "index.json"),
      JSON.stringify({
        version: 1,
        activeClientId: "client_aabbccdd",
        accountDefaults: {},
        clients: {
          client_aabbccdd: {
            clientId: "client_aabbccdd",
            userId: "user-1",
            serverUrl: "https://first-tree.example",
            storage: "active-root",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(readActiveClientIdFromIndex(home)).toBe("client_aabbccdd");
  });

  it("does not recover parked or malformed active client ids from the switch index", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-bad-active-index-"));
    tempHomes.push(home);
    mkdirSync(join(home, "parked-clients"), { recursive: true });
    writeFileSync(
      join(home, "parked-clients", "index.json"),
      JSON.stringify({
        version: 1,
        activeClientId: "client_aabbccdd",
        accountDefaults: {},
        clients: {
          client_aabbccdd: {
            clientId: "client_aabbccdd",
            userId: "user-1",
            serverUrl: "https://first-tree.example",
            storage: "parked",
            parkedPath: join(home, "parked-clients", "client_aabbccdd"),
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(readActiveClientIdFromIndex(home)).toBeNull();

    writeFileSync(
      join(home, "parked-clients", "index.json"),
      JSON.stringify({
        version: 1,
        activeClientId: "client_aabbccdd",
        accountDefaults: {},
        clients: {
          client_aabbccdd: {
            clientId: "client_11223344",
            userId: "user-1",
            serverUrl: "https://first-tree.example",
            storage: "active-root",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    expect(readActiveClientIdFromIndex(home)).toBeNull();
  });

  it("persists a generated active-root client id without overwriting an existing id", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ft-client-id-persist-"));
    tempHomes.push(configDir);
    const configPath = join(configDir, "client.yaml");
    writeFileSync(configPath, "server:\n  url: https://first-tree.example\n");

    ensureActiveRootClientIdPersisted("client_aabbccdd", configDir);
    expect(readFileSync(configPath, "utf8")).toContain("id: client_aabbccdd");

    ensureActiveRootClientIdPersisted("client_11223344", configDir);
    const yaml = readFileSync(configPath, "utf8");
    expect(yaml).toContain("id: client_aabbccdd");
    expect(yaml).not.toContain("client_11223344");
  });
});
