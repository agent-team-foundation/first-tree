import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AMP_INSTALL_COMMAND,
  findAmpExecutableOnPath,
  formatAmpBinaryMissingMessage,
  resolveAmpRuntimeBinary,
} from "../binary.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Amp binary resolution", () => {
  it("finds the operator-installed binary without launching it", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-amp-bin-"));
    roots.push(root);
    const binary = join(root, "amp");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findAmpExecutableOnPath(
        { PATH: root },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });

  it("finds ~/.local/bin and ~/.amp/bin when PATH is empty", () => {
    const root = mkdtempSync(join(tmpdir(), "ft-amp-home-"));
    roots.push(root);
    const binary = join(root, ".amp", "bin", "amp");
    mkdirSync(join(root, ".amp", "bin"), { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 0\n");
    chmodSync(binary, 0o755);

    expect(
      findAmpExecutableOnPath(
        { HOME: root, PATH: "" },
        { platform: "linux", wellKnownDirs: () => [], loginShellPathDirs: () => [] },
      ),
    ).toBe(binary);
  });

  it("resolves without launching", () => {
    expect(resolveAmpRuntimeBinary({}, { findOnPath: () => "/opt/bin/amp" })).toEqual({
      ok: true,
      binary: "/opt/bin/amp",
    });
  });

  it("reports a missing binary with the official installer and host login", () => {
    const result = resolveAmpRuntimeBinary({}, { findOnPath: () => null });
    expect(result).toMatchObject({ ok: false, transient: false });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain(AMP_INSTALL_COMMAND);
    expect(result.error).toContain("amp login");
    expect(formatAmpBinaryMissingMessage("no amp binary")).toContain("First Tree does not bundle or install Amp");
  });
});
