import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWslDbusOvermount } from "../commands/daemon/_shared/wsl-dbus.js";

const readFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: readFileSyncMock,
  };
});

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
}

describe("isWslDbusOvermount", () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it("returns false without reading /proc/version outside Linux", () => {
    setPlatform("darwin");
    readFileSyncMock.mockReturnValue("Linux version 5.15.90.1-microsoft-standard-WSL2");

    expect(isWslDbusOvermount("Failed to connect to bus: No such file or directory")).toBe(false);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("returns false without reading /proc/version when the reason is not a dbus connection failure", () => {
    setPlatform("linux");
    readFileSyncMock.mockReturnValue("Linux version 5.15.90.1-microsoft-standard-WSL2");

    expect(isWslDbusOvermount("systemctl exited with code 1")).toBe(false);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("detects the WSL dbus overmount from a Linux Microsoft kernel banner", () => {
    setPlatform("linux");
    readFileSyncMock.mockReturnValue("Linux version 5.15.90.1-microsoft-standard-WSL2");

    expect(isWslDbusOvermount("failed to connect to bus: no such file or directory")).toBe(true);
    expect(readFileSyncMock).toHaveBeenCalledWith("/proc/version", "utf8");
  });

  it("returns false for Linux kernels that are not WSL", () => {
    setPlatform("linux");
    readFileSyncMock.mockReturnValue("Linux version 6.8.0-generic");

    expect(isWslDbusOvermount("FAILED TO CONNECT TO BUS: No such file or directory")).toBe(false);
  });

  it("returns false when /proc/version cannot be read", () => {
    setPlatform("linux");
    readFileSyncMock.mockImplementation(() => {
      throw new Error("permission denied");
    });

    expect(isWslDbusOvermount("Failed to connect to bus: No such file or directory")).toBe(false);
  });
});
