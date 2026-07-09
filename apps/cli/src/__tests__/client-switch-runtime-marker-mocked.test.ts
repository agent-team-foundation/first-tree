import { afterEach, describe, expect, it, vi } from "vitest";

type FsMode = "readdir-string-error" | "read-string-error" | "live-without-command" | "live-with-empty-command";

async function loadClientSwitchWithFsMode(mode: FsMode) {
  vi.resetModules();
  vi.doMock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
      ...actual,
      existsSync: vi.fn((path: string) => path.includes("client-runtimes") || actual.existsSync(path)),
      readdirSync: vi.fn(() => {
        if (mode === "readdir-string-error") throw "cannot list markers";
        return ["123.json"];
      }),
      readFileSync: vi.fn((path: string) => {
        if (path.includes("client-runtimes") && mode === "read-string-error") throw "cannot read marker";
        if (path.endsWith("123.json")) {
          return JSON.stringify({
            version: 1,
            pid: 123,
            clientId: "client_aabbccdd",
            home: "/tmp/ft-home",
            mode: "foreground",
            createdAt: new Date().toISOString(),
          });
        }
        if (path.includes("/proc/") && mode === "live-with-empty-command") return "";
        if (path.includes("/proc/")) throw new Error(`unexpected read ${path}`);
        return actual.readFileSync(path);
      }),
    };
  });
  return import("../core/client-switch.js");
}

describe("client switch runtime marker mocked fs edges", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("stringifies non-Error marker directory failures", async () => {
    const { listLiveClientRuntimeMarkers } = await loadClientSwitchWithFsMode("readdir-string-error");

    expect(() => listLiveClientRuntimeMarkers("/tmp/ft-home")).toThrow("cannot list markers");
  });

  it("stringifies non-Error marker read failures", async () => {
    const { listLiveClientRuntimeMarkers } = await loadClientSwitchWithFsMode("read-string-error");

    expect(() => listLiveClientRuntimeMarkers("/tmp/ft-home")).toThrow("cannot read marker");
  });

  it("keeps live markers when the process command cannot be read", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const { listLiveClientRuntimeMarkers } = await loadClientSwitchWithFsMode("live-without-command");

      expect(listLiveClientRuntimeMarkers("/tmp/ft-home", "client_aabbccdd")).toEqual([
        {
          pid: 123,
          clientId: "client_aabbccdd",
          mode: "foreground",
          command: undefined,
        },
      ]);
    } finally {
      kill.mockRestore();
    }
  });

  it("keeps live markers when the process command is blank", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const { listLiveClientRuntimeMarkers } = await loadClientSwitchWithFsMode("live-with-empty-command");

      expect(listLiveClientRuntimeMarkers("/tmp/ft-home", "client_aabbccdd")).toEqual([
        {
          pid: 123,
          clientId: "client_aabbccdd",
          mode: "foreground",
          command: undefined,
        },
      ]);
    } finally {
      kill.mockRestore();
    }
  });

  it("treats non-ESRCH kill failures as live marker processes", async () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("permission denied"), { code: "EPERM" });
    });
    try {
      const { listLiveClientRuntimeMarkers } = await loadClientSwitchWithFsMode("live-with-empty-command");

      expect(listLiveClientRuntimeMarkers("/tmp/ft-home", "client_aabbccdd")).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
  });
});
