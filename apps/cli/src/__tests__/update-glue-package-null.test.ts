import { beforeEach, describe, expect, it, vi } from "vitest";

const updateMocks = vi.hoisted(() => ({
  detectInstallMode: vi.fn(),
  fetchServerCommandVersion: vi.fn(),
  installGlobalSpec: vi.fn(),
  installPortableSpec: vi.fn(),
  PACKAGE_NAME: null,
}));

const updateStateMocks = vi.hoisted(() => ({
  isLoopGuarded: vi.fn(),
  recordUpdateAttempt: vi.fn(),
}));

const printLineMock = vi.hoisted(() => vi.fn());

vi.mock("../core/update.js", () => updateMocks);
vi.mock("../core/update-state.js", () => updateStateMocks);
vi.mock("../core/output.js", () => ({
  print: { line: printLineMock },
}));

function output(): string {
  return printLineMock.mock.calls.map((call) => String(call[0])).join("");
}

describe("update glue package-name fallback", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    updateMocks.detectInstallMode.mockReturnValue("global");
    updateMocks.installGlobalSpec.mockResolvedValue({
      ok: true,
      mode: "global",
      installedVersion: "0.6.0",
    });
    updateStateMocks.isLoopGuarded.mockReturnValue(false);
  });

  it("uses the channel binary name when package metadata is unavailable", async () => {
    const { createExecuteUpdate } = await import("../core/update-glue.js");

    updateMocks.detectInstallMode.mockReturnValueOnce("npx");
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: false });
    expect(output()).toContain("./scripts/dev-install.sh");
    expect(output()).not.toContain("npm i -g");

    printLineMock.mockClear();
    updateStateMocks.isLoopGuarded.mockReturnValueOnce(true);
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(output()).toContain("npm install -g first-tree-dev@latest");

    printLineMock.mockClear();
    updateStateMocks.isLoopGuarded.mockReturnValue(false);
    await expect(
      createExecuteUpdate({ managed: false })({ currentVersion: "0.5.0", targetVersion: "0.6.0" }),
    ).resolves.toEqual({ installed: true });
    expect(output()).toContain("npm install -g first-tree-dev@0.6.0");
  });
});
