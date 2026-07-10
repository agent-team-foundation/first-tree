import type { CapabilityEntry } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import { buildInstallCommand, CURSOR_INSTALL_COMMAND, providerReinstallCommand } from "../providers.js";
import { installBoxView } from "../runtime-install-box.js";

const errorEntry = (): CapabilityEntry => ({
  state: "error",
  available: false,
  sdkVersion: null,
  detectedAt: "2026-06-17T00:00:00.000Z",
  error: "probe crashed",
});

const missingEntry = (): CapabilityEntry => ({
  state: "missing",
  available: false,
  sdkVersion: null,
  detectedAt: "2026-06-17T00:00:00.000Z",
});

describe("installBoxView — cursor uses the curl installer, never a broken npm line", () => {
  it("error state renders the cursor curl installer (not `npm install -g `)", () => {
    const view = installBoxView(errorEntry(), "cursor", "this-mac");
    expect(view.command).toBe(CURSOR_INSTALL_COMMAND);
    expect(view.command).not.toContain("npm install -g");
  });

  it("missing state renders the curl installer + cursor login", () => {
    const view = installBoxView(missingEntry(), "cursor", "this-mac");
    expect(view.command).toBe(`${CURSOR_INSTALL_COMMAND}\ncursor-agent login`);
    expect(view.command).not.toContain("npm install -g");
  });

  it("still renders the npm template for an npm-distributed provider (codex)", () => {
    const view = installBoxView(errorEntry(), "codex", "this-mac");
    expect(view.command).toBe("npm install -g @openai/codex");
  });
});

describe("provider install command helpers", () => {
  it("providerReinstallCommand overrides the npm template for cursor only", () => {
    expect(providerReinstallCommand("cursor")).toBe(CURSOR_INSTALL_COMMAND);
    expect(providerReinstallCommand("codex")).toBe("npm install -g @openai/codex");
    expect(providerReinstallCommand("claude-code")).toBe("npm install -g @anthropic-ai/claude-code");
  });

  it("buildInstallCommand appends the cursor login to the curl installer", () => {
    expect(buildInstallCommand("cursor")).toBe(`${CURSOR_INSTALL_COMMAND}\ncursor-agent login`);
  });
});
