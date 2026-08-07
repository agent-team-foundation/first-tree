import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { contextIntegrationReleaseManifestSchema } from "@first-tree/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectContextAdapterNextSessionObligation } from "../core/context-integration/adapter-observation.js";
import {
  contextIntegrationMarketplaceSourcePath,
  installContextIntegration,
  planContextIntegrationInstall,
  uninstallContextIntegration,
} from "../core/context-integration/installer.js";
import {
  readContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "../core/context-integration/manifest.js";
import {
  contextPluginTreeDigest,
  materializeContextPluginPayload,
} from "../core/context-integration/payload-integrity.js";
import type {
  ContextIntegrationProviderDriver,
  ProviderPluginProbe,
} from "../core/context-integration/provider-driver.js";
import { COMMAND_VERSION } from "../core/version.js";

const roots: string[] = [];
const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const originalInstallMode = process.env.FIRST_TREE_INSTALL_MODE;
const originalPortableRoot = process.env.FIRST_TREE_PORTABLE_ROOT;
const originalPortableBinDir = process.env.FIRST_TREE_PORTABLE_BIN_DIR;

beforeEach(() => {
  delete process.env.FIRST_TREE_INSTALL_MODE;
  delete process.env.FIRST_TREE_PORTABLE_ROOT;
  delete process.env.FIRST_TREE_PORTABLE_BIN_DIR;
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
  if (originalInstallMode === undefined) delete process.env.FIRST_TREE_INSTALL_MODE;
  else process.env.FIRST_TREE_INSTALL_MODE = originalInstallMode;
  if (originalPortableRoot === undefined) delete process.env.FIRST_TREE_PORTABLE_ROOT;
  else process.env.FIRST_TREE_PORTABLE_ROOT = originalPortableRoot;
  if (originalPortableBinDir === undefined) delete process.env.FIRST_TREE_PORTABLE_BIN_DIR;
  else process.env.FIRST_TREE_PORTABLE_BIN_DIR = originalPortableBinDir;
});

describe("context integration bundle", () => {
  it("persists a Claude next-session obligation before provider mutation", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(process.execPath, [
      join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
      "--out-dir",
      releaseRoot,
      "--version",
      COMMAND_VERSION,
      "--channel",
      "dev",
    ]);
    const installedPath = join(home, "provider-cache", "first-tree-context");
    const initialProbe: ProviderPluginProbe = {
      provider: "claude-code",
      binaryAvailable: true,
      version: "2.1.121",
      compatible: true,
      installed: false,
      enabled: false,
      installedPath: null,
      issues: [],
    };
    const driver: ContextIntegrationProviderDriver = {
      provider: "claude-code",
      executable: "claude",
      minimumVersion: "2.1.121",
      probe: () => initialProbe,
      inspectHook: async () => ({ trust: "provider_managed", enabled: true, source: "provider_managed", issues: [] }),
      validateMarketplace: () => undefined,
      install: ({ marketplaceRoot }) => {
        expect(inspectContextAdapterNextSessionObligation()).toBe("setup");
        cpSync(join(marketplaceRoot, "plugins", "first-tree-context"), installedPath, { recursive: true });
        return { ...initialProbe, installed: true, enabled: true, installedPath };
      },
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    const installed = installContextIntegration(driver, plan, { nextSessionObligationKind: "setup" });

    expect(inspectContextAdapterNextSessionObligation()).toBe("setup");
    expect(installed.manifest.materializedPayloadDigest).toMatch(/^sha256:/u);
    expect(installed.manifest.materializedMarketplaceDigest).toMatch(/^sha256:/u);
    expect(installed.manifest.adoptionGeneration).toBeUndefined();
    expect(readFileSync(join(installedPath, "hooks", "hooks.json"), "utf8")).not.toContain("adoption-generation");

    const compatibleSession = join(
      home,
      "state",
      "context",
      "providers",
      "claude-code",
      "compatible-sessions",
      "old.json",
    );
    mkdirSync(join(compatibleSession, ".."), { recursive: true });
    writeFileSync(compatibleSession, "old compatible session\n");
    uninstallContextIntegration(driver);
    expect(existsSync(compatibleSession)).toBe(false);
    const failingDriver: ContextIntegrationProviderDriver = {
      ...driver,
      install: () => {
        expect(inspectContextAdapterNextSessionObligation()).toBe("setup");
        throw new Error("provider install failed");
      },
    };
    const failingPlan = planContextIntegrationInstall(failingDriver, { releaseRoot });
    expect(() => installContextIntegration(failingDriver, failingPlan, { nextSessionObligationKind: "setup" })).toThrow(
      "provider install failed",
    );
    expect(inspectContextAdapterNextSessionObligation()).toBeNull();
  });

  it("packages only thin provider discovery stubs and keeps canonical Core paths in the CLI release", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-context-bundle-"));
    roots.push(root);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        root,
        "--version",
        "1.2.3",
        "--channel",
        "staging",
      ],
      { stdio: "pipe" },
    );

    const manifest = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")),
    );
    expect(manifest.policyDigest).toBe(manifest.core.policy.digest);
    expect(manifest.core.policy.path).toBe("dist/runtime-assets/context-tree-policy.md");
    expect(manifest.core.skills["first-tree-read"].path).toBe("skills/first-tree-read/SKILL.md");
    expect(manifest.core.skills["first-tree-write"].path).toBe("skills/first-tree-write/SKILL.md");
    for (const provider of ["claude-code", "codex"]) {
      const pluginRoot = join(root, provider, "plugins", "first-tree-context");
      const hook = readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8");
      const readSkill = readFileSync(join(pluginRoot, "skills", "first-tree-read", "SKILL.md"), "utf8");
      const writeSkill = readFileSync(join(pluginRoot, "skills", "first-tree-write", "SKILL.md"), "utf8");
      const manualSkill = readFileSync(join(pluginRoot, "skills", "first-tree", "SKILL.md"), "utf8");
      expect(manifest.providers[provider as "claude-code" | "codex"].adapterVersion).toBe(
        provider === "claude-code" ? "1.0.2" : "1.0.1",
      );
      expect(hook).toContain('"timeout": 5');
      expect(hook).toContain('"matcher": "startup|resume|clear|compact"');
      expect(hook).toContain("--adapter-digest __ADAPTER_DIGEST__");
      expect(hook).not.toContain('"UserPromptSubmit"');
      expect(hook).not.toContain("context-observe-loaded");
      expect(hook).not.toContain("__RELEASE_DIGEST__");
      expect(readSkill).toContain(`context skill load --protocol 1 --provider ${provider} --name first-tree-read`);
      expect(writeSkill).toContain(`context skill load --protocol 1 --provider ${provider} --name first-tree-write`);
      expect(manualSkill).toContain(`context skill load --protocol 1 --provider ${provider} --name first-tree-read`);
      for (const [skill, name] of [
        [readSkill, "first-tree-read"],
        [writeSkill, "first-tree-write"],
        [manualSkill, "first-tree-read"],
      ] as const) {
        expect(skill).toContain("For every new First Tree Context task");
        expect(skill).toContain(`exact \`(${name}, skillDigest)\` pair`);
        expect(skill).toContain("exact `policyDigest`");
        expect(skill).toContain("still directly available in the current provider context");
        expect(skill).toContain("Read and Write may share only this Policy reuse");
        expect(skill).toContain("matching path, Skill name, release version, or summary");
        expect(skill).toContain("startup, resume, clear, or compact as a cache miss");
        expect(skill).toContain("Do not create a persistent Core cache");
        expect(skill).toContain("do not run an independent `sha256sum`");
      }
      expect(readSkill).toContain(
        `description: Load the current First Tree release's canonical task-scoped Context reader for ${provider}.`,
      );
      expect(writeSkill).toContain(
        `description: Load the current First Tree release's canonical source-backed Context writer for ${provider}.`,
      );
      expect(manualSkill).toContain(
        `description: Manually activate First Tree Team Context for the current ${provider} project, including pathless sessions. Use when the user asks to enable, activate, or use First Tree Context in the current session.`,
      );
      expect(readSkill).not.toContain("context route");
      expect(writeSkill).not.toContain("context write-preflight");
      expect(readdirSync(join(pluginRoot, "skills", "first-tree-read"))).toEqual(["SKILL.md"]);
      expect(readdirSync(join(pluginRoot, "skills", "first-tree-write"))).toEqual(["SKILL.md"]);
      expect(manualSkill).toContain("current session's original project identity");
    }
    expect(readdirSync(join(root, "codex", "plugins", "first-tree-context", "skills"))).not.toContain(
      "first-tree-seed",
    );
  });

  it("materializes identical Claude payload bytes for the same adapter version", () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-deterministic-release-"));
    const firstRoot = mkdtempSync(join(tmpdir(), "first-tree-context-deterministic-first-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "first-tree-context-deterministic-second-"));
    roots.push(releaseRoot, firstRoot, secondRoot);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(process.execPath, [
      join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
      "--out-dir",
      releaseRoot,
      "--version",
      "1.2.3",
      "--channel",
      "staging",
    ]);
    const source = join(releaseRoot, "claude-code", "plugins", "first-tree-context");
    cpSync(source, firstRoot, { recursive: true });
    cpSync(source, secondRoot, { recursive: true });
    const release = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(releaseRoot, "release-manifest.json"), "utf8")),
    );
    const invocation = { kind: "bin" as const, program: "/stable/first-tree" };

    materializeContextPluginPayload(firstRoot, release.providers["claude-code"].adapterDigest, invocation);
    materializeContextPluginPayload(secondRoot, release.providers["claude-code"].adapterDigest, invocation);

    expect(contextPluginTreeDigest(firstRoot)).toBe(contextPluginTreeDigest(secondRoot));
  });

  it("emits the flattened Core Policy path used by portable app artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "first-tree-portable-context-bundle-"));
    roots.push(root);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        root,
        "--version",
        "1.2.3",
        "--channel",
        "staging",
        "--core-policy-path",
        "runtime-assets/context-tree-policy.md",
      ],
      { stdio: "pipe" },
    );

    const manifest = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(root, "release-manifest.json"), "utf8")),
    );
    expect(manifest.core.policy.path).toBe("runtime-assets/context-tree-policy.md");
  });

  it("keeps adapter identity and bytes stable across a Core-only CLI release", () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "first-tree-context-bundle-first-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "first-tree-context-bundle-second-"));
    const planRoot = mkdtempSync(join(tmpdir(), "first-tree-context-bundle-plan-"));
    const coreRoot = mkdtempSync(join(tmpdir(), "first-tree-context-core-"));
    roots.push(firstRoot, secondRoot, planRoot, coreRoot);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    cpSync(join(repoRoot, "skills"), join(coreRoot, "skills"), { recursive: true });
    const policyTarget = join(coreRoot, "packages", "client", "src", "runtime", "assets");
    mkdirSync(policyTarget, { recursive: true });
    cpSync(
      join(repoRoot, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"),
      join(policyTarget, "context-tree-policy.md"),
    );
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        firstRoot,
        "--version",
        "1.2.3",
        "--channel",
        "dev",
        "--core-root",
        coreRoot,
      ],
      { stdio: "pipe" },
    );
    writeFileSync(
      join(coreRoot, "skills", "first-tree-read", "SKILL.md"),
      `${readFileSync(join(coreRoot, "skills", "first-tree-read", "SKILL.md"), "utf8")}\nCore-only change.\n`,
    );
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        secondRoot,
        "--version",
        "1.2.4",
        "--channel",
        "dev",
        "--core-root",
        coreRoot,
      ],
      { stdio: "pipe" },
    );
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        planRoot,
        "--version",
        COMMAND_VERSION,
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const first = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(firstRoot, "release-manifest.json"), "utf8")),
    );
    const second = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(secondRoot, "release-manifest.json"), "utf8")),
    );
    expect(first.core.digest).not.toBe(second.core.digest);
    for (const provider of ["claude-code", "codex"] as const) {
      expect(first.providers[provider]).toEqual(second.providers[provider]);
      expect(snapshotTree(join(firstRoot, provider))).toEqual(snapshotTree(join(secondRoot, provider)));
    }

    const home = mkdtempSync(join(tmpdir(), "first-tree-context-core-only-home-"));
    const installedPath = join(home, "provider-cache", "first-tree-context");
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
    const marketplaceRoot = contextIntegrationMarketplaceSourcePath("codex");
    cpSync(join(firstRoot, "codex"), marketplaceRoot, { recursive: true });
    const invocation = materializeContextPluginPayload(
      join(marketplaceRoot, "plugins", "first-tree-context"),
      first.providers.codex.adapterDigest,
      { kind: "bin", program: "/opt/first-tree/bin/first-tree" },
    );
    cpSync(join(marketplaceRoot, "plugins", "first-tree-context"), installedPath, { recursive: true });
    writeContextIntegrationInstallManifest({
      schemaVersion: 1,
      accountClientId: "client_1234abcd",
      channel: "dev",
      provider: "codex",
      firstTreeVersion: "1.2.3",
      bundleVersion: "1.2.3",
      adapterVersion: first.providers.codex.adapterVersion,
      loaderProtocolVersion: 1,
      bundleDigest: first.bundleDigest,
      policyDigest: first.policyDigest,
      adapterDigest: first.providers.codex.adapterDigest,
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
      materializedInvocation: invocation,
      installedAt: "2026-08-05T00:00:00.000Z",
    });
    const probe: ProviderPluginProbe = {
      provider: "codex",
      binaryAvailable: true,
      version: "0.145.0",
      compatible: true,
      installed: true,
      enabled: true,
      installedPath,
      issues: [],
    };
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => probe,
      inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install: () => probe,
      uninstall: () => undefined,
    };

    expect(planContextIntegrationInstall(driver, { releaseRoot: planRoot }).operation).toBe("unchanged");
  });

  it.each([
    ["prod", "first-tree"],
    ["staging", "first-tree-staging"],
    ["dev", "first-tree-dev"],
  ])("materializes every %s Skill command with the exact channel invocation", (channel, binName) => {
    const releaseRoot = mkdtempSync(join(tmpdir(), `first-tree-context-${channel}-release-`));
    const pluginRoot = mkdtempSync(join(tmpdir(), `first-tree-context-${channel}-plugin-`));
    roots.push(releaseRoot, pluginRoot);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "1.2.3",
        "--channel",
        channel,
      ],
      { stdio: "pipe" },
    );
    cpSync(join(releaseRoot, "codex", "plugins", "first-tree-context"), pluginRoot, { recursive: true });
    const manifest = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(releaseRoot, "release-manifest.json"), "utf8")),
    );
    const invocation = `/opt/first-tree/${binName}`;
    materializeContextPluginPayload(pluginRoot, manifest.providers.codex.adapterDigest, {
      kind: "bin",
      program: invocation,
    });

    for (const skill of ["first-tree", "first-tree-read", "first-tree-write"]) {
      const content = readFileSync(join(pluginRoot, "skills", skill, "SKILL.md"), "utf8");
      expect(content).toContain(invocation);
      expect(content).not.toContain("__FIRST_TREE_SKILL_INVOCATION__");
      expect(content).not.toMatch(/(^|[` ])first-tree\s+(?:chat|context|github|gitlab|tree)\b/mu);
    }
  });

  it("materializes hostile invocation characters as literal shell arguments", () => {
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-quoted-release-"));
    const pluginRoot = mkdtempSync(join(tmpdir(), "first-tree-context-quoted-plugin-"));
    const runtimeRoot = mkdtempSync(join(tmpdir(), "first-tree-context-quoted-runtime-"));
    roots.push(releaseRoot, pluginRoot, runtimeRoot);
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        "1.2.3",
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    cpSync(join(releaseRoot, "codex", "plugins", "first-tree-context"), pluginRoot, { recursive: true });
    const manifest = contextIntegrationReleaseManifestSchema.parse(
      JSON.parse(readFileSync(join(releaseRoot, "release-manifest.json"), "utf8")),
    );
    const captureScript = join(runtimeRoot, "capture args.sh");
    const captureOutput = join(runtimeRoot, "captured.txt");
    const substitutionMarker = join(runtimeRoot, "substitution-ran");
    const backtickMarker = join(runtimeRoot, "backtick-ran");
    const hostile = `space ' $(touch ${substitutionMarker}) \`touch ${backtickMarker}\``;
    writeFileSync(captureScript, 'printf \'%s\\n\' "$@" > "$CAPTURE_OUTPUT"\n');

    materializeContextPluginPayload(pluginRoot, manifest.providers.codex.adapterDigest, {
      kind: "node",
      program: "/bin/sh",
      args: [captureScript, hostile],
    });
    execFileSync(join(pluginRoot, "bin", "context-session-start"), [], {
      env: { ...process.env, CAPTURE_OUTPUT: captureOutput },
    });

    expect(readFileSync(captureOutput, "utf8").split("\n").slice(0, 5)).toEqual([
      hostile,
      "context",
      "activate",
      "--provider",
      "codex",
    ]);
    expect(existsSync(substitutionMarker)).toBe(false);
    expect(existsSync(backtickMarker)).toBe(false);
    const skill = readFileSync(join(pluginRoot, "skills", "first-tree", "SKILL.md"), "utf8");
    expect(skill).toContain("'\"'\"'");
    expect(skill).not.toContain("__FIRST_TREE_SKILL_INVOCATION__");
  });

  it("restores the previous provider cache when an update fails", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    const installedPath = join(home, "provider-cache", "first-tree-context");
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
    mkdirSync(installedPath, { recursive: true });
    writeFileSync(join(installedPath, "old-release.txt"), "previous\n");
    mkdirSync(join(installedPath, "bin"), { recursive: true });
    writeFileSync(join(installedPath, "bin", "context-session-start"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });

    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        COMMAND_VERSION,
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    writeContextIntegrationInstallManifest({
      schemaVersion: 1,
      channel: "dev",
      provider: "codex",
      firstTreeVersion: "0.5.16",
      bundleVersion: "0.5.16",
      bundleDigest: `sha256:${"1".repeat(64)}`,
      policyDigest: `sha256:${"2".repeat(64)}`,
      adapterDigest: `sha256:${"3".repeat(64)}`,
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
      installedAt: "2026-07-28T00:00:00.000Z",
    });

    const probe: ProviderPluginProbe = {
      provider: "codex",
      binaryAvailable: true,
      version: "0.144.1",
      compatible: true,
      installed: true,
      enabled: true,
      installedPath,
      issues: [],
    };
    const installedMarketplaces: string[] = [];
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.1",
      probe: () => probe,
      inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install: ({ marketplaceRoot }) => {
        installedMarketplaces.push(marketplaceRoot);
        if (installedMarketplaces.length === 1) throw new Error("provider install failed");
        expect(readFileSync(join(marketplaceRoot, "plugins", "first-tree-context", "old-release.txt"), "utf8")).toBe(
          "previous\n",
        );
        return probe;
      },
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    expect(plan.operation).toBe("repair");
    expect(() => installContextIntegration(driver, plan)).toThrow("provider install failed");
    expect(installedMarketplaces).toHaveLength(2);
    expect(readContextIntegrationInstallManifest("codex")?.bundleDigest).toBe(`sha256:${"1".repeat(64)}`);
    expect(existsSync(join(home, "state", "context", "install-journal.json"))).toBe(false);
    expect(existsSync(join(home, "state", "context", "install.lock"))).toBe(false);
  });

  it("cleans a provider-owned partial install even when no manifest was committed", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    const uninstall = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.145.0",
        compatible: true,
        installed: true,
        enabled: true,
        installedPath: "/provider/cache/first-tree-context",
        issues: [],
      }),
      inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install: () => {
        throw new Error("not used");
      },
      uninstall,
    };

    uninstallContextIntegration(driver);
    expect(uninstall).toHaveBeenCalledWith({
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
    });
    expect(existsSync(join(home, "state", "context", "install-journal.json"))).toBe(false);
    expect(existsSync(join(home, "state", "context", "install.lock"))).toBe(false);
  });

  it("retains the provider marketplace source until a successful uninstall", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        COMMAND_VERSION,
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const installedPath = join(home, "provider-cache", "first-tree-context");
    const probe: ProviderPluginProbe = {
      provider: "codex",
      binaryAvailable: true,
      version: "0.145.0",
      compatible: true,
      installed: false,
      enabled: false,
      installedPath: null,
      issues: [],
    };
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => probe,
      inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
      validateMarketplace: () => undefined,
      install: ({ marketplaceRoot }) => {
        expect(marketplaceRoot).toBe(contextIntegrationMarketplaceSourcePath("codex"));
        expect(existsSync(join(marketplaceRoot, "plugins", "first-tree-context"))).toBe(true);
        cpSync(join(marketplaceRoot, "plugins", "first-tree-context"), installedPath, { recursive: true });
        return { ...probe, installed: true, enabled: true, installedPath };
      },
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    const installed = installContextIntegration(driver, plan);
    const marketplaceSource = contextIntegrationMarketplaceSourcePath("codex");
    expect(existsSync(join(marketplaceSource, "plugins", "first-tree-context"))).toBe(true);
    expect(installed.manifest.materializedInvocation).toBeTruthy();
    expect(
      readFileSync(join(marketplaceSource, "plugins", "first-tree-context", "bin", "context-session-start"), "utf8"),
    ).toContain(installed.manifest.materializedInvocation);

    uninstallContextIntegration(driver);
    expect(existsSync(marketplaceSource)).toBe(false);
    expect(readContextIntegrationInstallManifest("codex")).toBeNull();
  });

  it("does not commit a ready manifest when the provider cache differs from the installed source", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        COMMAND_VERSION,
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const installedPath = join(home, "provider-cache", "first-tree-context");
    const initialProbe: ProviderPluginProbe = {
      provider: "codex",
      binaryAvailable: true,
      version: "0.145.0",
      compatible: true,
      installed: false,
      enabled: false,
      installedPath: null,
      issues: [],
    };
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => initialProbe,
      inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
      validateMarketplace: () => undefined,
      install: ({ marketplaceRoot }) => {
        cpSync(join(marketplaceRoot, "plugins", "first-tree-context"), installedPath, { recursive: true });
        writeFileSync(join(installedPath, "skills", "first-tree-write", "SKILL.md"), "old");
        return { ...initialProbe, installed: true, enabled: true, installedPath };
      },
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    expect(() => installContextIntegration(driver, plan)).toThrow(
      "The provider-installed Context Plugin payload does not match",
    );
    expect(readContextIntegrationInstallManifest("codex")).toBeNull();
  });

  it("rejects an install plan when provider state changes before mutation", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        COMMAND_VERSION,
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    let probeCount = 0;
    const install = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.145.0",
        compatible: true,
        installed: probeCount++ > 0,
        enabled: true,
        installedPath: null,
        issues: [],
      }),
      inspectHook: async () => ({ trust: "trusted", enabled: true, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install,
      uninstall: () => undefined,
    };

    const plan = planContextIntegrationInstall(driver, { releaseRoot });
    expect(() => installContextIntegration(driver, plan)).toThrow(
      "The provider Plugin state changed after the displayed plan.",
    );
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(join(home, "state", "context", "install.lock"))).toBe(false);
  });

  it("rejects a provider below the release minimum before any mutation", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        COMMAND_VERSION,
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const install = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.100.0",
        compatible: false,
        installed: false,
        enabled: false,
        installedPath: null,
        issues: ["Codex 0.100.0 is older than the required 0.144.0."],
      }),
      inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
      validateMarketplace: () => undefined,
      install,
      uninstall: () => undefined,
    };

    expect(() => planContextIntegrationInstall(driver, { releaseRoot })).toThrow("Upgrade to 0.144.0 or newer");
    expect(install).not.toHaveBeenCalled();
  });

  it("refuses repair while a previously installed provider Plugin is disabled", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    const releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-context-release-"));
    roots.push(home, releaseRoot);
    process.env.FIRST_TREE_HOME = home;
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
        "--out-dir",
        releaseRoot,
        "--version",
        COMMAND_VERSION,
        "--channel",
        "dev",
      ],
      { stdio: "pipe" },
    );
    const install = vi.fn();
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({
        provider: "codex",
        binaryAvailable: true,
        version: "0.145.0",
        compatible: true,
        installed: true,
        enabled: false,
        installedPath: "/provider/cache/first-tree-context",
        issues: [],
      }),
      inspectHook: async () => ({ trust: "trusted", enabled: false, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install,
      uninstall: () => undefined,
    };

    expect(() => planContextIntegrationInstall(driver, { releaseRoot })).toThrow("installed but disabled");
    expect(install).not.toHaveBeenCalled();
  });

  it("does not overwrite another provider's incomplete recovery journal", () => {
    const home = mkdtempSync(join(tmpdir(), "first-tree-context-home-"));
    roots.push(home);
    process.env.FIRST_TREE_HOME = home;
    const journalPath = join(home, "state", "context", "install-journal.json");
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        provider: "claude-code",
        operation: "repair",
        previousBundleDigest: `sha256:${"1".repeat(64)}`,
        targetBundleDigest: `sha256:${"2".repeat(64)}`,
        startedAt: "2026-07-28T00:00:00.000Z",
        phase: "rollback_failed",
      })}\n`,
    );
    const driver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => {
        throw new Error("must not probe");
      },
      inspectHook: async () => {
        throw new Error("must not inspect");
      },
      validateMarketplace: () => undefined,
      install: () => {
        throw new Error("must not install");
      },
      uninstall: () => undefined,
    };

    expect(() => planContextIntegrationInstall(driver, { releaseRoot: "/unused" })).toThrow(
      "A claude-code Context Plugin operation is incomplete.",
    );
    expect(existsSync(journalPath)).toBe(true);
  });
});

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (directory: string, prefix = ""): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(path, name);
      else if (entry.isFile()) snapshot[name] = readFileSync(path).toString("base64");
    }
  };
  visit(root);
  return snapshot;
}
