import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const confirmMock = vi.fn<() => Promise<boolean>>();
const printBlankMock = vi.fn();
const printLineMock = vi.fn();
const warnMock = vi.fn();

class TestClientOrgMismatchError extends Error {
  readonly code = "CLIENT_ORG_MISMATCH";
}

async function loadHandler() {
  vi.resetModules();
  vi.doMock("@first-tree/client", () => ({ createLogger: () => ({ warn: warnMock }) }));
  vi.doMock("@inquirer/prompts", () => ({ confirm: confirmMock }));
  vi.doMock("../core/output.js", () => ({
    print: {
      blank: printBlankMock,
      line: printLineMock,
    },
  }));
  return import("../core/client-reidentify.js");
}

describe("handleClientOrgMismatch", () => {
  let dir: string;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = mkdtempSync(join(tmpdir(), "first-tree-reidentify-handler-"));
    writeFileSync(
      join(dir, "client.yaml"),
      stringifyYaml({ client: { id: "client_old" }, server: { url: "https://hub.example.test" } }),
      { mode: 0o600 },
    );
    confirmMock.mockResolvedValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      if (code === 0) {
        // Vitest needs the success path to keep running; real process.exit never returns.
        return undefined as never;
      }
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("prompts interactive users and exits with a rerun hint after rotation", async () => {
    const { handleClientOrgMismatch } = await loadHandler();

    await expect(
      handleClientOrgMismatch(new TestClientOrgMismatchError("wrong org"), {
        configDir: dir,
        managed: false,
        rerunCommand: "first-tree daemon start",
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(confirmMock).toHaveBeenCalledWith({
      default: true,
      message: "Rotate the local client identity and register fresh?",
    });
    expect(warnMock).not.toHaveBeenCalled();
    expect(printLineMock.mock.calls.flat().join("")).toContain("first-tree daemon start");

    const updated = parseYaml(readFileSync(join(dir, "client.yaml"), "utf-8"));
    expect(updated.client.id).toMatch(/^client_[a-f0-9]{8}$/);
    expect(updated.client.id).not.toBe("client_old");
  });

  it("skips the prompt in managed mode and logs the rotation", async () => {
    const { handleClientOrgMismatch } = await loadHandler();

    await expect(
      handleClientOrgMismatch(new TestClientOrgMismatchError("wrong org"), {
        configDir: dir,
        managed: true,
        rerunCommand: "first-tree daemon start",
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).toHaveBeenCalledWith(0);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(warnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        backupPath: join(dir, "client.yaml.bak"),
        oldId: "client_old",
      }),
      "client identity rotated on CLIENT_ORG_MISMATCH (managed mode)",
    );
    expect(printLineMock.mock.calls.flat().join("")).toContain("background service");
  });

  it("exits without rotating when the user declines", async () => {
    confirmMock.mockResolvedValueOnce(false);
    const { handleClientOrgMismatch } = await loadHandler();

    await expect(
      handleClientOrgMismatch(new TestClientOrgMismatchError("wrong org"), {
        configDir: dir,
        managed: false,
        rerunCommand: "first-tree daemon start",
      }),
    ).rejects.toThrow("exit:1");

    const unchanged = parseYaml(readFileSync(join(dir, "client.yaml"), "utf-8"));
    expect(unchanged.client.id).toBe("client_old");
    expect(printLineMock.mock.calls.flat().join("")).toContain("Aborted");
  });

  it("treats prompt failures as a decline", async () => {
    confirmMock.mockRejectedValueOnce(new Error("tty closed"));
    const { handleClientOrgMismatch } = await loadHandler();

    await expect(
      handleClientOrgMismatch(new TestClientOrgMismatchError("wrong org"), {
        configDir: dir,
        managed: false,
        rerunCommand: "first-tree daemon start",
      }),
    ).rejects.toThrow("exit:1");

    expect(printLineMock.mock.calls.flat().join("")).toContain("Aborted");
  });

  it("reports rotation failures and exits non-zero", async () => {
    rmSync(join(dir, "client.yaml"), { force: true });
    const { handleClientOrgMismatch } = await loadHandler();

    await expect(
      handleClientOrgMismatch(new TestClientOrgMismatchError("wrong org"), {
        configDir: dir,
        managed: false,
        rerunCommand: "first-tree daemon start",
      }),
    ).rejects.toThrow("exit:1");

    expect(printLineMock.mock.calls.flat().join("")).toContain("Failed to rotate client identity");
  });
});
