import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLocalCliAvailability, isExecutableOnPath } from "../runtime/local-cli.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local provider CLI detection", () => {
  it("detects gh and glab from PATH without launching either CLI", () => {
    const checked: string[] = [];
    const availability = detectLocalCliAvailability({
      env: { PATH: "/provider/bin" },
      isExecutable: (filePath) => {
        checked.push(filePath);
        return filePath === "/provider/bin/gh" || filePath === "/provider/bin/glab";
      },
    });

    expect(availability).toEqual({ github: true, gitlab: true });
    expect(checked).toEqual(["/provider/bin/gh", "/provider/bin/glab"]);
  });

  it("rejects directories", () => {
    const directory = mkdtempSync(join(tmpdir(), "first-tree-local-cli-"));
    temporaryDirectories.push(directory);
    const glab = join(directory, "glab");
    mkdirSync(glab);

    expect(isExecutableOnPath("glab", { env: { PATH: directory } })).toBe(false);
  });

  it.runIf(process.platform !== "win32")("requires the executable bit on POSIX", () => {
    const directory = mkdtempSync(join(tmpdir(), "first-tree-local-cli-"));
    temporaryDirectories.push(directory);
    const gh = join(directory, "gh");
    writeFileSync(gh, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    expect(isExecutableOnPath("gh", { env: { PATH: directory } })).toBe(false);

    chmodSync(gh, 0o755);
    expect(isExecutableOnPath("gh", { env: { PATH: directory } })).toBe(true);
  });

  it("uses Windows path semantics and case-insensitive environment keys", () => {
    const checked: string[] = [];
    const options = {
      env: { PaTh: String.raw`"C:\Provider Bin";D:\Other`, PathExt: " .CMD ; EXE ; .cmd " },
      platform: "win32" as const,
      isExecutable: (filePath: string) => {
        checked.push(filePath);
        return filePath === String.raw`C:\Provider Bin\gh.CMD`;
      },
    };

    expect(isExecutableOnPath("gh", options)).toBe(true);
    expect(checked).toEqual([String.raw`C:\Provider Bin\gh.CMD`]);
  });

  it("uses the selected platform path delimiter by default", () => {
    const availability = detectLocalCliAvailability({
      env: { path: "/provider/bin:/other/bin" },
      platform: "linux",
      isExecutable: (filePath) => filePath === "/other/bin/glab",
    });

    expect(availability).toEqual({ github: false, gitlab: true });
  });

  it("treats empty PATH entries as the current directory", () => {
    const checked: string[] = [];

    expect(
      isExecutableOnPath("gh", {
        env: { PATH: ":/provider/bin" },
        platform: "linux",
        isExecutable: (filePath) => {
          checked.push(filePath);
          return filePath === "gh";
        },
      }),
    ).toBe(true);
    expect(checked).toEqual(["gh"]);
  });

  it("does not probe when PATH is absent", () => {
    const isExecutable = vi.fn(() => true);

    expect(isExecutableOnPath("gh", { env: {}, isExecutable })).toBe(false);
    expect(isExecutable).not.toHaveBeenCalled();
  });

  it("uses only the bare name when Windows PATHEXT is explicitly empty", () => {
    const checked: string[] = [];

    expect(
      isExecutableOnPath("glab", {
        env: { Path: String.raw`C:\Tools`, PATHEXT: "" },
        platform: "win32",
        isExecutable: (filePath) => {
          checked.push(filePath);
          return filePath === String.raw`C:\Tools\glab`;
        },
      }),
    ).toBe(true);
    expect(checked).toEqual([String.raw`C:\Tools\glab`]);
  });
});
