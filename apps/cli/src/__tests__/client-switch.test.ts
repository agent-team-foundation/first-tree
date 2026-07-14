import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_SWITCH_INTERRUPTED_REASON,
  clientRuntimeMarkerPath,
  collectSwitchDrainProcessFromEnvText,
  ensureActiveRootClientIdPersisted,
  getClientSwitchStartupBlock,
  hasIncompleteClientSwitch,
  isSwitchDrainEnvRequired,
  listLiveClientRuntimeMarkers,
  parseSwitchProcessEnvValue,
  readActiveClientIdFromIndex,
  readActiveClientOwner,
  readActiveRootClientId,
  readRememberedLocalClientIdForAccount,
  recordActiveClientOwner,
  registerClientRuntimeMarker,
  resolveClientRuntimeStopReason,
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

  it("returns null or an empty string for missing and blank process text values", () => {
    expect(parseSwitchProcessEnvValue("FIRST_TREE_HOME= FIRST_TREE_CLIENT_ID=client_aabbccdd", "FIRST_TREE_HOME")).toBe(
      "",
    );
    expect(parseSwitchProcessEnvValue("FIRST_TREE_HOME=", "FIRST_TREE_HOME")).toBe("");
    expect(parseSwitchProcessEnvValue("FIRST_TREE_HOME=/tmp/ft", "FIRST_TREE_CLIENT_ID")).toBeNull();
    expect(parseSwitchProcessEnvValue("FIRST_TREE_HOME=/tmp/ft", "FIRST.TREE")).toBeNull();
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

  it("ignores processes outside the active home or without First Tree markers", () => {
    const providers: Array<{ pid: number; provider: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];

    collectSwitchDrainProcessFromEnvText({
      pid: 120,
      command: "node worker.js",
      envText: "FIRST_TREE_HOME=/tmp/other FIRST_TREE_CLIENT_ID=client_aabbccdd FIRST_TREE_SWITCH_DRAIN_VERSION=1",
      home: "/tmp/ft",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });
    collectSwitchDrainProcessFromEnvText({
      pid: 121,
      command: "node worker.js",
      envText: "FIRST_TREE_HOME=/tmp/ft",
      home: "/tmp/ft",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });
    collectSwitchDrainProcessFromEnvText({
      pid: 122,
      command: "first-tree daemon start --foreground",
      envText: "FIRST_TREE_HOME=/tmp/ft",
      home: "/tmp/ft",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(providers).toEqual([]);
    expect(issues).toEqual([]);
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

  it("fails closed when a trusted marker belongs to another client", () => {
    const providers: Array<{ pid: number; provider: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];

    collectSwitchDrainProcessFromEnvText({
      pid: 125,
      command: "/usr/bin/codex exec",
      envText: [
        "FIRST_TREE_HOME=/Users/alice/.first-tree",
        "FIRST_TREE_CLIENT_ID=client_11223344",
        "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
        "",
      ].join("\0"),
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(providers).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({ pid: 125, reason: "belongs to another client (client_11223344)" }),
    ]);
  });

  it("records provider, agent, and chat markers for known provider commands", () => {
    const providers: Array<{ pid: number; provider: string; agentId?: string; chatId?: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];

    collectSwitchDrainProcessFromEnvText({
      pid: 126,
      command: "/usr/local/bin/claude",
      envText: [
        "FIRST_TREE_HOME=/Users/alice/.first-tree",
        "FIRST_TREE_PROVIDER=claude",
        "FIRST_TREE_CLIENT_ID=client_aabbccdd",
        "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
        "FIRST_TREE_AGENT_ID=agent-1",
        "FIRST_TREE_CHAT_ID=chat-1",
        "",
      ].join("\0"),
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(issues).toEqual([]);
    expect(providers).toEqual([
      expect.objectContaining({
        pid: 126,
        provider: "claude",
        agentId: "agent-1",
        chatId: "chat-1",
      }),
    ]);
  });

  it("falls back to unknown-provider for known provider commands without provider markers", () => {
    const providers: Array<{ pid: number; provider: string; agentId?: string; chatId?: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];

    collectSwitchDrainProcessFromEnvText({
      pid: 127,
      command: "/usr/local/bin/codex",
      envText: [
        "FIRST_TREE_HOME=/Users/alice/.first-tree",
        "FIRST_TREE_CLIENT_ID=client_aabbccdd",
        "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
        "",
      ].join("\0"),
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(issues).toEqual([]);
    expect(providers).toEqual([expect.objectContaining({ pid: 127, provider: "unknown-provider" })]);
  });

  it("fails closed on known provider commands that lack trusted markers", () => {
    const providers: Array<{ pid: number; provider: string; command: string }> = [];
    const issues: Array<{ pid: number; command: string; reason: string }> = [];

    collectSwitchDrainProcessFromEnvText({
      pid: 128,
      command: "/usr/local/bin/codex",
      envText: "FIRST_TREE_HOME=/Users/alice/.first-tree",
      home: "/Users/alice/.first-tree",
      clientId: "client_aabbccdd",
      providers,
      issues,
    });

    expect(providers).toEqual([]);
    expect(issues).toEqual([expect.objectContaining({ pid: 128, reason: "missing trusted switch drain markers" })]);
  });

  it("requires readable env only for known switch-drain process commands", () => {
    expect(isSwitchDrainEnvRequired("/usr/bin/codex exec")).toBe(true);
    expect(isSwitchDrainEnvRequired("node /app/node_modules/@openai/codex/bin.js")).toBe(true);
    expect(isSwitchDrainEnvRequired("node ./node_modules/claude-code/cli.js")).toBe(true);
    expect(isSwitchDrainEnvRequired("first-tree-dev daemon start --foreground")).toBe(true);
    expect(isSwitchDrainEnvRequired("node cli/index.mjs daemon start --foreground")).toBe(true);
    expect(isSwitchDrainEnvRequired("first-tree daemon status")).toBe(false);
    expect(isSwitchDrainEnvRequired("/bin/bash unrelated-script")).toBe(false);
  });

  it("recognizes Cursor CLI processes (cursor-agent and the official `agent` command)", () => {
    // The drain must fail closed: a live Cursor turn spawned by the runtime
    // (either official symlink name) must require the env envelope check.
    expect(isSwitchDrainEnvRequired("/home/op/.local/bin/cursor-agent -p --output-format stream-json")).toBe(true);
    expect(isSwitchDrainEnvRequired("/home/op/.local/bin/agent -p --output-format stream-json")).toBe(true);
    expect(isSwitchDrainEnvRequired("cursor-agent login")).toBe(true);
  });
});

describe("client runtime markers", () => {
  it("registers and clears runtime markers idempotently", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-runtime-register-"));
    tempHomes.push(home);

    const clear = registerClientRuntimeMarker({
      clientId: "client_aabbccdd",
      mode: "foreground",
      home,
      pid: process.pid,
    });
    const markerPath = clientRuntimeMarkerPath(home, process.pid);

    expect(readFileSync(markerPath, "utf8")).toContain("client_aabbccdd");
    clear();
    clear();
    expect(existsSync(markerPath)).toBe(false);
  });

  it("uses default home and pid when registering runtime markers", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-runtime-defaults-"));
    tempHomes.push(home);
    const previousHome = process.env.FIRST_TREE_HOME;
    process.env.FIRST_TREE_HOME = home;
    try {
      const clear = registerClientRuntimeMarker({
        clientId: "client_aabbccdd",
        mode: "service",
      });
      const markerPath = clientRuntimeMarkerPath(home, process.pid);

      expect(readFileSync(markerPath, "utf8")).toContain('"mode": "service"');
      clear();
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.FIRST_TREE_HOME;
      else process.env.FIRST_TREE_HOME = previousHome;
    }
  });

  it("lists a live runtime marker and includes the process command when available", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-runtime-live-"));
    tempHomes.push(home);
    const clear = registerClientRuntimeMarker({
      clientId: "client_aabbccdd",
      mode: "foreground",
      home,
      pid: process.pid,
    });

    const markers = listLiveClientRuntimeMarkers(home, "client_aabbccdd");

    expect(markers).toEqual([
      expect.objectContaining({
        pid: process.pid,
        clientId: "client_aabbccdd",
        mode: "foreground",
      }),
    ]);
    clear();
  });

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

  it("ignores marker files for another home, version, or client filter", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-runtime-filter-"));
    tempHomes.push(home);
    const markerDir = join(home, "state", "client-runtimes");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "note.txt"), "ignored");
    writeFileSync(
      join(markerDir, "version.json"),
      JSON.stringify({ version: 2, pid: process.pid, clientId: "client_aabbccdd", home, mode: "foreground" }),
    );
    writeFileSync(
      join(markerDir, "home.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        clientId: "client_aabbccdd",
        home: "/tmp/other",
        mode: "foreground",
      }),
    );
    writeFileSync(
      join(markerDir, "client.json"),
      JSON.stringify({ version: 1, pid: process.pid, clientId: "client_11223344", home, mode: "foreground" }),
    );

    expect(listLiveClientRuntimeMarkers(home, "client_aabbccdd")).toEqual([]);
  });

  it("fails closed when a runtime marker cannot be parsed", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-runtime-bad-marker-"));
    tempHomes.push(home);
    const markerDir = join(home, "state", "client-runtimes");
    mkdirSync(markerDir, { recursive: true });
    writeFileSync(join(markerDir, "bad.json"), "{ not-json");

    expect(() => listLiveClientRuntimeMarkers(home)).toThrow(/Unable to read runtime marker/u);
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

  it("short-circuits invalid, current, and already-stopped runtime pids", async () => {
    await expect(stopClientRuntimeProcess(-1)).resolves.toEqual({ ok: true, alreadyStopped: true });
    await expect(stopClientRuntimeProcess(process.pid)).resolves.toEqual({
      ok: false,
      reason: "refusing to stop the current CLI process",
    });
    await expect(stopClientRuntimeProcess(999_999_999)).resolves.toEqual({ ok: true, alreadyStopped: true });
  });

  it("reports process kill failures and ESRCH races", async () => {
    const kill = vi.spyOn(process, "kill");
    kill
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        const err = Object.assign(new Error("gone"), { code: "ESRCH" });
        throw err;
      });

    await expect(stopClientRuntimeProcess(12345)).resolves.toEqual({ ok: true, alreadyStopped: true });

    kill
      .mockImplementationOnce(() => true)
      .mockImplementationOnce(() => {
        const err = Object.assign(new Error("permission denied"), { code: "EPERM" });
        throw err;
      });

    await expect(stopClientRuntimeProcess(12346)).resolves.toEqual({ ok: false, reason: "permission denied" });
    kill.mockRestore();
  });

  it("uses default stop timing options and stringifies non-Error kill failures", async () => {
    let alive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        if (alive) return true;
        const err = Object.assign(new Error("gone"), { code: "ESRCH" });
        throw err;
      }
      alive = false;
      return true;
    });

    await expect(stopClientRuntimeProcess(12348)).resolves.toEqual({ ok: true });

    kill.mockImplementation((_pid, signal) => {
      if (signal === 0) return true;
      throw "kill failed as string";
    });
    await expect(stopClientRuntimeProcess(12349)).resolves.toEqual({
      ok: false,
      reason: "kill failed as string",
    });
    kill.mockRestore();
  });

  it("times out when a runtime process does not stop after the signal", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    const res = await stopClientRuntimeProcess(12347, { timeoutMs: 5, intervalMs: 1 });

    expect(res).toEqual({
      ok: false,
      reason: expect.stringContaining("timed out waiting for pid"),
    });
    kill.mockRestore();
  });

  it("handles runtime stop races after the wait deadline", async () => {
    let probes = 0;
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) {
        probes += 1;
        if (probes === 1) return true;
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true;
    });

    await expect(stopClientRuntimeProcess(12350, { timeoutMs: 0, intervalMs: 1 })).resolves.toEqual({ ok: true });
    kill.mockRestore();
  });

  it("treats non-Error liveness probe failures as live before surfacing signal failures", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) throw "probe failed";
      throw "signal failed";
    });

    await expect(stopClientRuntimeProcess(12351)).resolves.toEqual({ ok: false, reason: "signal failed" });
    kill.mockRestore();
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

    writeFileSync(
      join(home, "parked-clients", "index.json"),
      JSON.stringify({
        version: 1,
        activeClientId: "not-a-client-id",
        accountDefaults: {},
        clients: {},
      }),
    );

    expect(readActiveClientIdFromIndex(home)).toBeNull();
  });

  it("recovers active client owner and remembered defaults from the switch index", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-owner-index-"));
    const configDir = mkdtempSync(join(tmpdir(), "ft-client-owner-config-"));
    tempHomes.push(home, configDir);
    mkdirSync(join(home, "parked-clients"), { recursive: true });
    writeFileSync(
      join(home, "parked-clients", "index.json"),
      JSON.stringify({
        version: 1,
        activeClientId: "client_aabbccdd",
        accountDefaults: {
          "https://first-tree.example\nuser-1": "client_aabbccdd",
        },
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
    writeFileSync(join(configDir, "client.yaml"), "client:\n  id: client_aabbccdd\n");

    expect(readActiveRootClientId(configDir)).toBe("client_aabbccdd");
    expect(readActiveClientOwner(home, configDir)).toEqual({
      clientId: "client_aabbccdd",
      userId: "user-1",
      serverUrl: "https://first-tree.example",
    });
    expect(readRememberedLocalClientIdForAccount("https://first-tree.example", "user-1", home)).toBe("client_aabbccdd");

    writeFileSync(join(configDir, "client.yaml"), "client:\n  id: client_11223344\n");
    expect(readActiveClientOwner(home, configDir)).toBeNull();
  });

  it("parks any prior active-root entry when recording a new active owner", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-record-owner-"));
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
            userId: "old-user",
            serverUrl: "https://old.example",
            storage: "active-root",
            updatedAt: new Date().toISOString(),
          },
        },
      }),
    );

    recordActiveClientOwner(
      { clientId: "client_11223344", userId: "new-user", serverUrl: "https://new.example" },
      home,
    );

    const index = JSON.parse(readFileSync(join(home, "parked-clients", "index.json"), "utf8")) as {
      activeClientId: string;
      accountDefaults: Record<string, string>;
      clients: Record<string, { storage: string; parkedPath?: string }>;
    };
    expect(index.activeClientId).toBe("client_11223344");
    expect(index.clients.client_aabbccdd?.storage).toBe("parked");
    expect(index.clients.client_aabbccdd?.parkedPath).toContain("client_aabbccdd");
    expect(index.clients.client_11223344?.storage).toBe("active-root");
    expect(index.accountDefaults["https://new.example\nnew-user"]).toBe("client_11223344");
  });

  it("persists a generated active-root client id without overwriting an existing id", () => {
    const configDir = mkdtempSync(join(tmpdir(), "ft-client-id-persist-"));
    tempHomes.push(configDir);
    const configPath = join(configDir, "client.yaml");
    writeFileSync(configPath, "server:\n  url: https://first-tree.example\n");

    ensureActiveRootClientIdPersisted("client_aabbccdd", configDir);
    expect(readFileSync(configPath, "utf8")).toContain("id: client_aabbccdd");

    ensureActiveRootClientIdPersisted("client_aabbccdd", configDir);
    expect(readFileSync(configPath, "utf8")).toContain("id: client_aabbccdd");

    ensureActiveRootClientIdPersisted("client_11223344", configDir);
    const yaml = readFileSync(configPath, "utf8");
    expect(yaml).toContain("id: client_aabbccdd");
    expect(yaml).not.toContain("client_11223344");
  });

  it("does not persist malformed client ids and detects incomplete switches", () => {
    const home = mkdtempSync(join(tmpdir(), "ft-client-switch-block-"));
    const configDir = mkdtempSync(join(tmpdir(), "ft-client-id-invalid-"));
    tempHomes.push(home, configDir);
    writeFileSync(join(configDir, "client.yaml"), "server:\n  url: https://first-tree.example\n");

    ensureActiveRootClientIdPersisted("bad-client-id", configDir);
    expect(readFileSync(join(configDir, "client.yaml"), "utf8")).not.toContain("bad-client-id");
    expect(getClientSwitchStartupBlock(home)).toBeNull();
    expect(resolveClientRuntimeStopReason(home)).toBeUndefined();
    expect(hasIncompleteClientSwitch(home)).toBe(false);

    mkdirSync(join(home, "state"), { recursive: true });
    writeFileSync(join(home, "state", "client-switch.lock"), "{}");
    writeFileSync(
      join(home, "state", "client-switch-journal.json"),
      JSON.stringify({
        version: 1,
        id: "switch-test",
        phase: "service-stopped",
        from: { clientId: "client_aabbccdd", userId: "old", serverUrl: "https://old.example" },
        to: { userId: "new", serverUrl: "https://new.example" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    expect(getClientSwitchStartupBlock(home)).toEqual({
      lockPath: join(home, "state", "client-switch.lock"),
      journalPath: join(home, "state", "client-switch-journal.json"),
    });
    expect(resolveClientRuntimeStopReason(home)).toBe(CLIENT_SWITCH_INTERRUPTED_REASON);
    expect(hasIncompleteClientSwitch(home)).toBe(true);
  });
});
