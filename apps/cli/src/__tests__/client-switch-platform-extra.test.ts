import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  mode: "normal" as
    | "normal"
    | "proc-readdir-error"
    | "proc-readdir-string-error"
    | "proc-readdir-error-second"
    | "proc-cmdline-error"
    | "proc-cmdline-disappeared"
    | "proc-cmdline-string-error"
    | "proc-environ-error"
    | "proc-environ-string-error"
    | "proc-status-no-uid"
    | "proc-many-providers"
    | "proc-untrusted"
    | "marker-readdir-error"
    | "exdev"
    | "pending-rename-error"
    | "pending-rename-exdev"
    | "write-json-rename-error"
    | "write-json-cleanup-error",
  home: "",
  uid: typeof process.getuid === "function" ? process.getuid() : 0,
  procReaddirCount: 0,
}));

const execState = vi.hoisted(() => ({
  mode: "ok" as
    | "ok"
    | "throw"
    | "throw-string"
    | "daemon-untrusted"
    | "daemon-active"
    | "many-daemon-untrusted"
    | "pid-throw",
  home: "",
}));

const outputMocks = vi.hoisted(() => ({
  fail: vi.fn((code: string, message: string, exitCode = 1) => {
    throw Object.assign(new Error(message), { code, exitCode });
  }),
  line: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  getClientServiceStatus: vi.fn(() => ({ state: "inactive", platform: "test" })),
  stopClientService: vi.fn(() => ({ ok: true })),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      const text = String(path);
      if (fsState.mode === "proc-cmdline-disappeared" && text.startsWith("/proc/100")) return false;
      if (text.startsWith("/proc/100")) return true;
      return actual.existsSync(path);
    },
    readdirSync: ((path: Parameters<typeof actual.readdirSync>[0], options?: unknown) => {
      const text = String(path);
      if (text === "/proc") {
        fsState.procReaddirCount += 1;
        if (fsState.mode === "exdev") return [];
        if (fsState.mode === "proc-readdir-error") throw new Error("proc unavailable");
        if (fsState.mode === "proc-readdir-string-error") throw "proc unavailable as string";
        if (fsState.mode === "proc-readdir-error-second" && fsState.procReaddirCount > 1) {
          throw new Error("proc unavailable after first scan");
        }
        if (fsState.mode === "proc-readdir-error-second") return [];
        if (fsState.mode === "proc-many-providers") {
          return Array.from({ length: 9 }, (_value, index) => String(100 + index));
        }
        return ["100", "self", "not-a-pid"];
      }
      if (text.endsWith("/state/client-runtimes") && fsState.mode === "marker-readdir-error") {
        throw new Error("marker dir denied");
      }
      return (actual.readdirSync as (...args: unknown[]) => unknown)(path, options);
    }) as typeof actual.readdirSync,
    readFileSync: ((path: Parameters<typeof actual.readFileSync>[0], options?: unknown) => {
      const text = String(path);
      if (/^\/proc\/\d+\/status$/u.test(text)) {
        if (fsState.mode === "proc-status-no-uid") return "Name:\tnode\n";
        return `Name:\tnode\nUid:\t${fsState.uid}\t${fsState.uid}\t${fsState.uid}\t${fsState.uid}\n`;
      }
      if (/^\/proc\/\d+\/cmdline$/u.test(text)) {
        if (fsState.mode === "proc-cmdline-disappeared") throw new Error("process disappeared");
        if (fsState.mode === "proc-cmdline-string-error") throw "cmdline denied as string";
        if (fsState.mode === "proc-cmdline-error") throw new Error("cmdline denied");
        return "codex exec";
      }
      if (/^\/proc\/\d+\/environ$/u.test(text)) {
        if (fsState.mode === "proc-environ-string-error") throw "environ denied as string";
        if (fsState.mode === "proc-environ-error") throw new Error("environ denied");
        if (fsState.mode === "proc-untrusted") {
          return [`FIRST_TREE_HOME=${fsState.home}`, "FIRST_TREE_PROVIDER=codex", ""].join("\0");
        }
        return [
          `FIRST_TREE_HOME=${fsState.home}`,
          "FIRST_TREE_PROVIDER=codex",
          "FIRST_TREE_CLIENT_ID=client_aabbccdd",
          "FIRST_TREE_SWITCH_DRAIN_VERSION=1",
          "",
        ].join("\0");
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(path, options);
    }) as typeof actual.readFileSync,
    statSync: ((path: Parameters<typeof actual.statSync>[0], options?: unknown) => {
      const stat = (actual.statSync as (...args: unknown[]) => unknown)(path, options) as ReturnType<
        typeof actual.statSync
      >;
      if (fsState.mode === "exdev") {
        const text = String(path);
        if (text.endsWith("/config/client.yaml")) {
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: 1 });
        }
        if (text.includes("/parked-clients/client_aabbccdd/config")) {
          return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: 2 });
        }
      }
      return stat;
    }) as typeof actual.statSync,
    renameSync: ((
      oldPath: Parameters<typeof actual.renameSync>[0],
      newPath: Parameters<typeof actual.renameSync>[1],
    ) => {
      if (fsState.mode === "pending-rename-exdev" && !String(oldPath).includes(".tmp.")) {
        throw Object.assign(new Error("cross-device pending move"), { code: "EXDEV" });
      }
      if (fsState.mode === "pending-rename-error" && !String(oldPath).includes(".tmp.")) {
        throw new Error("pending rename denied");
      }
      if (
        (fsState.mode === "write-json-rename-error" || fsState.mode === "write-json-cleanup-error") &&
        String(oldPath).includes(".tmp.")
      ) {
        throw new Error("atomic rename denied");
      }
      return actual.renameSync(oldPath, newPath);
    }) as typeof actual.renameSync,
    unlinkSync: ((path: Parameters<typeof actual.unlinkSync>[0]) => {
      if (fsState.mode === "write-json-cleanup-error" && String(path).includes(".tmp.")) {
        throw new Error("cleanup denied");
      }
      return actual.unlinkSync(path);
    }) as typeof actual.unlinkSync,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn((program: string, args: string[]) => {
      if (program === "ps" && args.includes("-Eww")) {
        if (execState.mode === "throw") throw new Error("ps denied");
        if (execState.mode === "throw-string") throw "ps denied as string";
        if (execState.mode === "many-daemon-untrusted") {
          return Array.from(
            { length: 9 },
            (_value, index) =>
              `  ${200 + index} first-tree daemon start --foreground FIRST_TREE_HOME=${execState.home}`,
          ).join("\n");
        }
        if (execState.mode === "daemon-active") {
          return `  200 first-tree daemon start --foreground FIRST_TREE_HOME=${execState.home} FIRST_TREE_CLIENT_ID=client_aabbccdd\n`;
        }
        if (execState.mode === "daemon-untrusted") {
          return `  200 first-tree daemon start --foreground FIRST_TREE_HOME=${execState.home}\n`;
        }
        return `  200 codex exec FIRST_TREE_HOME=${execState.home} FIRST_TREE_PROVIDER=codex FIRST_TREE_CLIENT_ID=client_aabbccdd FIRST_TREE_SWITCH_DRAIN_VERSION=1\n`;
      }
      if (program === "ps" && args.includes("-p")) {
        if (execState.mode === "pid-throw") throw new Error("pid command denied");
        return "/usr/local/bin/first-tree-dev daemon start --foreground\n";
      }
      return (actual.execFileSync as (...execArgs: unknown[]) => unknown)(program, args);
    }),
  };
});

vi.mock("../cli/output.js", () => ({ fail: outputMocks.fail }));
vi.mock("../core/output.js", () => ({ print: { line: outputMocks.line } }));
vi.mock("../core/service-install.js", () => serviceMocks);

let home = "";
let originalHome: string | undefined;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

function writeClientYaml(): void {
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(
    join(home, "config", "client.yaml"),
    "server:\n  url: https://old.example\nclient:\n  id: client_aabbccdd\n",
  );
}

async function runSwitch(): Promise<void> {
  const { switchLocalClientForLogin } = await import("../core/client-switch.js");
  await switchLocalClientForLogin({
    existingCredentials: { accessToken: "old", refreshToken: "old-refresh", serverUrl: "https://old.example" },
    previousOwnerSub: "user-old",
    targetTokens: { accessToken: "new", refreshToken: "new-refresh", serverUrl: "https://new.example" },
    targetOwnerSub: "user-new",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  originalHome = process.env.FIRST_TREE_HOME;
  home = mkdtempSync(join(tmpdir(), "ft-client-switch-platform-"));
  process.env.FIRST_TREE_HOME = home;
  fsState.mode = "normal";
  fsState.home = home;
  execState.mode = "ok";
  execState.home = home;
  fsState.procReaddirCount = 0;
  serviceMocks.getClientServiceStatus.mockReturnValue({ state: "inactive", platform: "test" });
  writeClientYaml();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
  setPlatform(originalPlatform);
});

describe("client switch platform drain scanning", () => {
  it("fails when Linux provider markers are still live", async () => {
    setPlatform("linux");

    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_TIMEOUT" });
  });

  it("fails closed when Linux /proc cannot be inspected", async () => {
    setPlatform("linux");
    fsState.mode = "proc-readdir-error";

    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED" });

    writeClientYaml();
    fsState.mode = "proc-readdir-string-error";
    fsState.procReaddirCount = 0;
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("proc unavailable as string"),
    });

    writeClientYaml();
    fsState.mode = "proc-readdir-error-second";
    fsState.procReaddirCount = 0;
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("after first scan"),
    });
  });

  it("fails closed when Linux command or environment files are unreadable", async () => {
    setPlatform("linux");
    fsState.mode = "proc-cmdline-error";
    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED" });

    writeClientYaml();
    fsState.mode = "proc-cmdline-string-error";
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("cmdline denied as string"),
    });

    writeClientYaml();
    fsState.mode = "proc-cmdline-disappeared";
    await expect(runSwitch()).resolves.toBeUndefined();

    writeClientYaml();
    fsState.mode = "proc-environ-error";
    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED" });

    writeClientYaml();
    fsState.mode = "proc-environ-string-error";
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("environ denied as string"),
    });
  });

  it("ignores Linux processes without a readable uid and summarizes many provider markers", async () => {
    setPlatform("linux");
    fsState.mode = "proc-status-no-uid";

    await expect(runSwitch()).resolves.toBeUndefined();

    writeClientYaml();
    fsState.mode = "proc-many-providers";
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_TIMEOUT",
      message: expect.stringContaining("...and 1 more"),
    });
  });

  it("scans Linux processes when process.getuid is unavailable", async () => {
    setPlatform("linux");
    const originalGetuid = process.getuid;
    Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    try {
      await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_TIMEOUT" });
    } finally {
      Object.defineProperty(process, "getuid", { configurable: true, value: originalGetuid });
    }
  });

  it("fails closed on untrusted Linux provider-like processes", async () => {
    setPlatform("linux");
    fsState.mode = "proc-untrusted";

    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED" });
  });

  it("scans Darwin ps output for trusted and untrusted markers", async () => {
    setPlatform("darwin");
    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_TIMEOUT" });

    writeClientYaml();
    execState.mode = "daemon-untrusted";
    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED" });

    writeClientYaml();
    execState.mode = "daemon-active";
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("daemon runtime is still active"),
    });

    writeClientYaml();
    execState.mode = "many-daemon-untrusted";
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("...and 1 more"),
    });
  });

  it("fails closed when Darwin ps inspection fails or platform is unsupported", async () => {
    setPlatform("darwin");
    execState.mode = "throw";
    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED" });

    writeClientYaml();
    execState.mode = "throw-string";
    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED",
      message: expect.stringContaining("ps denied as string"),
    });

    writeClientYaml();
    setPlatform("win32");
    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_DRAIN_UNSUPPORTED" });
  });

  it("fails closed when the service state is unknown before or after stopping", async () => {
    serviceMocks.getClientServiceStatus.mockReturnValueOnce({ state: "unknown", platform: "test" });

    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_SUPERVISOR_UNSAFE",
      message: "Background service state could not be determined (test).",
    });

    writeClientYaml();
    serviceMocks.getClientServiceStatus
      .mockReset()
      .mockReturnValueOnce({ state: "active", platform: "test" })
      .mockReturnValueOnce({ state: "unknown", platform: "test" });
    serviceMocks.stopClientService.mockReturnValueOnce({ ok: true });

    await expect(runSwitch()).rejects.toMatchObject({
      code: "CLIENT_SWITCH_SUPERVISOR_UNSAFE",
      message: "Background service did not reach a safe stopped state (test).",
    });
  });

  it("surfaces runtime marker directory inspection failures", async () => {
    const { listLiveClientRuntimeMarkers } = await import("../core/client-switch.js");
    mkdirSync(join(home, "state", "client-runtimes"), { recursive: true });
    fsState.mode = "marker-readdir-error";

    expect(() => listLiveClientRuntimeMarkers(home)).toThrow(/Unable to inspect runtime markers/u);
  });

  it("reads runtime marker commands on Darwin and degrades when ps fails or the platform is unsupported", async () => {
    const { listLiveClientRuntimeMarkers, registerClientRuntimeMarker } = await import("../core/client-switch.js");

    setPlatform("darwin");
    registerClientRuntimeMarker({ clientId: "client_aabbccdd", mode: "foreground", home, pid: process.pid });
    expect(listLiveClientRuntimeMarkers(home, "client_aabbccdd")).toEqual([
      expect.objectContaining({ command: "/usr/local/bin/first-tree-dev daemon start --foreground" }),
    ]);

    execState.mode = "pid-throw";
    expect(listLiveClientRuntimeMarkers(home, "client_aabbccdd")).toEqual([
      expect.objectContaining({ command: undefined }),
    ]);

    setPlatform("win32");
    expect(listLiveClientRuntimeMarkers(home, "client_aabbccdd")).toEqual([
      expect.objectContaining({ command: undefined }),
    ]);
  });

  it("classifies cross-device preflight failures as client-switch EXDEV", async () => {
    setPlatform("linux");
    fsState.mode = "exdev";

    await expect(runSwitch()).rejects.toMatchObject({ code: "CLIENT_SWITCH_EXDEV" });
  });

  it("classifies pending recovery EXDEV but rethrows generic pending recovery errors", async () => {
    const { switchLocalClientForLogin, clientSwitchJournalPath, clientSwitchLockPath } = await import(
      "../core/client-switch.js"
    );
    const parkedTarget = join(home, "parked-clients", "client_11223344");
    mkdirSync(join(home, "state"), { recursive: true });
    mkdirSync(join(parkedTarget, "config"), { recursive: true });
    writeFileSync(
      join(parkedTarget, "config", "client.yaml"),
      "server:\n  url: https://new.example\nclient:\n  id: client_11223344\n",
    );
    rmSync(join(home, "config", "client.yaml"), { force: true });
    const journal = {
      version: 1,
      id: "switch-pending",
      phase: "parked-old-client",
      from: { clientId: "client_aabbccdd", userId: "user-old", serverUrl: "https://old.example" },
      to: { clientId: "client_11223344", userId: "user-new", serverUrl: "https://new.example" },
      moves: [
        {
          kind: "restore-client-yaml",
          group: "restore",
          source: join(parkedTarget, "config", "client.yaml"),
          target: join(home, "config", "client.yaml"),
          required: true,
          state: "pending",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(clientSwitchLockPath(home), JSON.stringify({ pid: process.pid }));
    writeFileSync(clientSwitchJournalPath(home), JSON.stringify(journal));

    fsState.mode = "pending-rename-exdev";
    await expect(
      switchLocalClientForLogin({
        targetTokens: { accessToken: "new", refreshToken: "new-refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toMatchObject({ code: "CLIENT_SWITCH_EXDEV" });

    fsState.mode = "pending-rename-error";
    await expect(
      switchLocalClientForLogin({
        targetTokens: { accessToken: "new", refreshToken: "new-refresh", serverUrl: "https://new.example" },
        targetOwnerSub: "user-new",
      }),
    ).rejects.toThrow("pending rename denied");
  });

  it("cleans up temporary JSON files after atomic write failures", async () => {
    const { registerClientRuntimeMarker } = await import("../core/client-switch.js");

    fsState.mode = "write-json-rename-error";
    expect(() =>
      registerClientRuntimeMarker({ clientId: "client_aabbccdd", mode: "foreground", home, pid: 991 }),
    ).toThrow("atomic rename denied");

    fsState.mode = "write-json-cleanup-error";
    expect(() =>
      registerClientRuntimeMarker({ clientId: "client_aabbccdd", mode: "foreground", home, pid: 992 }),
    ).toThrow("atomic rename denied");
  });
});
