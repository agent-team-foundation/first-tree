import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readContextIntegrationConfig,
  writeContextBinding,
} from "../core/context-integration/context-binding-store.js";
import { contextIntegrationMarketplaceSourcePath } from "../core/context-integration/installer.js";
import {
  readContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "../core/context-integration/manifest.js";
import {
  disableContextIntegrationOperation,
  enableContextIntegrationOperation,
  recoverContextIntegrationOperation,
  repairContextIntegrationOperation,
} from "../core/context-integration/operation.js";
import type {
  ContextIntegrationProviderDriver,
  ProviderPluginProbe,
} from "../core/context-integration/provider-driver.js";

const originalFirstTreeHome = process.env.FIRST_TREE_HOME;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalFirstTreeHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalFirstTreeHome;
});

function setupHome(prefix: string): string {
  const home = mkdtempSync(join(tmpdir(), prefix));
  roots.push(home);
  process.env.FIRST_TREE_HOME = home;
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  return home;
}

function writeRollbackPlugin(marketplaceRoot: string): void {
  const pluginRoot = join(marketplaceRoot, "plugins", "first-tree-context");
  mkdirSync(join(pluginRoot, "bin"), { recursive: true });
  writeFileSync(join(pluginRoot, "bin", "context-session-start"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(pluginRoot, "old.txt"), "old\n");
}

function probe(installed: boolean): ProviderPluginProbe {
  return {
    provider: "codex",
    binaryAvailable: true,
    version: "0.145.0",
    compatible: true,
    installed,
    enabled: installed,
    installedPath: installed ? "/provider/cache/first-tree-context" : null,
    issues: [],
  };
}

function driver(installed: boolean) {
  const install = vi.fn(({ marketplaceRoot }: { marketplaceRoot: string }) => {
    const installedPath = join(process.env.FIRST_TREE_HOME ?? "", "provider-cache", "first-tree-context");
    rmSync(installedPath, { recursive: true, force: true });
    cpSync(join(marketplaceRoot, "plugins", "first-tree-context"), installedPath, { recursive: true });
    return { ...probe(true), installedPath };
  });
  const uninstall = vi.fn();
  const value: ContextIntegrationProviderDriver = {
    provider: "codex",
    executable: "codex",
    minimumVersion: "0.144.0",
    probe: () => probe(installed),
    inspectHook: async () => ({
      trust: installed ? "trusted" : "unknown",
      enabled: installed ? true : null,
      source: installed ? "provider_api" : "unavailable",
      issues: [],
    }),
    validateMarketplace: () => undefined,
    install,
    uninstall,
  };
  return { value, install, uninstall };
}

function installManifest() {
  return {
    schemaVersion: 1 as const,
    channel: "dev" as const,
    provider: "codex" as const,
    firstTreeVersion: "0.5.17",
    bundleVersion: "0.5.17",
    bundleDigest: `sha256:${"1".repeat(64)}`,
    policyDigest: `sha256:${"2".repeat(64)}`,
    adapterDigest: `sha256:${"3".repeat(64)}`,
    marketplaceName: "first-tree-dev",
    pluginName: "first-tree-context",
    installedAt: "2026-07-28T00:00:00.000Z",
  };
}

describe("Context integration cross-resource operation", () => {
  it("fails closed before mutation when the provider Plugin is installed but disabled", () => {
    setupHome("first-tree-context-operation-disabled-");
    const manifest = installManifest();
    writeContextIntegrationInstallManifest(manifest);
    const stableMarketplace = contextIntegrationMarketplaceSourcePath("codex");
    writeRollbackPlugin(stableMarketplace);
    const install = vi.fn();
    const uninstall = vi.fn();
    const disabledDriver: ContextIntegrationProviderDriver = {
      provider: "codex",
      executable: "codex",
      minimumVersion: "0.144.0",
      probe: () => ({ ...probe(true), enabled: false }),
      inspectHook: async () => ({ trust: "trusted", enabled: false, source: "provider_api", issues: [] }),
      validateMarketplace: () => undefined,
      install,
      uninstall,
    };
    const expectedConfig = readContextIntegrationConfig();
    const binding = {
      provider: "codex" as const,
      checkoutRoot: "/work/payments",
      repositoryKey: "github.com/acme/payments",
      organizationId: "org-acme",
    };
    const plan = {
      provider: "codex" as const,
      operation: "repair" as const,
      previous: manifest,
      release: {
        root: "/unused",
        manifest: {
          schemaVersion: 1 as const,
          version: "0.5.17",
          channel: "dev" as const,
          bundleDigest: manifest.bundleDigest,
          policyDigest: manifest.policyDigest,
          providers: {
            codex: { adapterDigest: manifest.adapterDigest, minimumVersion: "0.144.0" },
            "claude-code": { adapterDigest: `sha256:${"4".repeat(64)}`, minimumVersion: "2.1.121" },
          },
        },
      },
      probe: { ...probe(true), enabled: false },
      marketplaceName: "first-tree-dev",
    };

    expect(() =>
      enableContextIntegrationOperation(disabledDriver, plan, binding, expectedConfig, "client_1234abcd"),
    ).toThrow("installed but disabled");
    expect(() =>
      disableContextIntegrationOperation(disabledDriver, {
        all: true,
        removePlugin: true,
        expectedConfig,
        expectedAccountClientId: "client_1234abcd",
      }),
    ).toThrow("installed but disabled");
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
  });

  it("rejects a stale binding plan before mutating the provider", () => {
    setupHome("first-tree-context-operation-stale-");
    const provider = driver(false);
    const expectedConfig = readContextIntegrationConfig();
    writeContextBinding({
      provider: "codex",
      checkoutRoot: "/work/other",
      repositoryKey: "github.com/acme/other",
      organizationId: "org-other",
    });

    expect(() =>
      enableContextIntegrationOperation(
        provider.value,
        {
          provider: "codex",
          operation: "install",
          previous: null,
          release: {
            root: "/unused",
            manifest: {
              schemaVersion: 1,
              version: "0.5.17",
              channel: "dev",
              bundleDigest: `sha256:${"1".repeat(64)}`,
              policyDigest: `sha256:${"2".repeat(64)}`,
              providers: {
                codex: { adapterDigest: `sha256:${"3".repeat(64)}`, minimumVersion: "0.144.0" },
                "claude-code": { adapterDigest: `sha256:${"4".repeat(64)}`, minimumVersion: "2.1.121" },
              },
            },
          },
          probe: probe(false),
          marketplaceName: "first-tree-dev",
        },
        {
          provider: "codex",
          checkoutRoot: "/work/payments",
          repositoryKey: "github.com/acme/payments",
          organizationId: "org-acme",
        },
        expectedConfig,
        "client_1234abcd",
      ),
    ).toThrow("changed after the displayed plan");

    expect(provider.install).not.toHaveBeenCalled();
    expect(provider.uninstall).not.toHaveBeenCalled();
  });

  it("rolls back a newly installed Plugin and manifest when binding persistence fails", () => {
    const home = setupHome("first-tree-context-operation-enable-");
    const provider = driver(false);
    const expectedConfig = readContextIntegrationConfig();
    const manifest = installManifest();
    const binding = {
      provider: "codex" as const,
      checkoutRoot: "/work/payments",
      repositoryKey: "github.com/acme/payments",
      organizationId: "org-acme",
    };

    expect(() =>
      enableContextIntegrationOperation(
        provider.value,
        {
          provider: "codex",
          operation: "install",
          previous: null,
          release: {
            root: "/unused",
            manifest: {
              schemaVersion: 1,
              version: "0.5.17",
              channel: "dev",
              bundleDigest: manifest.bundleDigest,
              policyDigest: manifest.policyDigest,
              providers: {
                codex: { adapterDigest: manifest.adapterDigest, minimumVersion: "0.144.0" },
                "claude-code": { adapterDigest: `sha256:${"4".repeat(64)}`, minimumVersion: "2.1.121" },
              },
            },
          },
          probe: probe(false),
          marketplaceName: "first-tree-dev",
        },
        binding,
        expectedConfig,
        "client_1234abcd",
        {
          install: () => {
            writeContextIntegrationInstallManifest(manifest);
            return { manifest, probe: probe(true) };
          },
          writeBinding: () => {
            throw new Error("binding rename failed");
          },
        },
      ),
    ).toThrow("binding rename failed");

    expect(readContextIntegrationConfig()).toEqual(expectedConfig);
    expect(readContextIntegrationInstallManifest("codex")).toBeNull();
    expect(provider.uninstall).toHaveBeenCalled();
    expect(existsSync(join(home, "state", "context", "operation-journal.json"))).toBe(false);
  });

  it("keeps the old binding and restores the old Plugin when provider uninstall fails", () => {
    const home = setupHome("first-tree-context-operation-disable-");
    const provider = driver(true);
    const manifest = installManifest();
    writeContextIntegrationInstallManifest(manifest);
    const stableMarketplace = contextIntegrationMarketplaceSourcePath("codex");
    writeRollbackPlugin(stableMarketplace);
    const binding = {
      provider: "codex" as const,
      checkoutRoot: "/work/payments",
      repositoryKey: "github.com/acme/payments",
      organizationId: "org-acme",
    };
    writeContextBinding(binding);
    const expectedConfig = readContextIntegrationConfig();

    expect(() =>
      disableContextIntegrationOperation(
        provider.value,
        {
          all: true,
          removePlugin: true,
          expectedConfig,
          expectedAccountClientId: "client_1234abcd",
        },
        {
          uninstall: () => {
            throw new Error("provider uninstall failed");
          },
        },
      ),
    ).toThrow("provider uninstall failed");

    expect(readContextIntegrationConfig()).toEqual(expectedConfig);
    expect(readContextIntegrationInstallManifest("codex")).toEqual(manifest);
    expect(provider.install).toHaveBeenCalledWith({
      marketplaceRoot: stableMarketplace,
      marketplaceName: "first-tree-dev",
      pluginName: "first-tree-context",
    });
    expect(existsSync(join(home, "state", "context", "operation-journal.json"))).toBe(false);
  });

  it("persists repair recovery state before the provider mutation starts", () => {
    const home = setupHome("first-tree-context-operation-repair-");
    const provider = driver(false);
    const manifest = installManifest();
    const plan = {
      provider: "codex" as const,
      operation: "install" as const,
      previous: null,
      release: {
        root: "/unused",
        manifest: {
          schemaVersion: 1 as const,
          version: "0.5.17",
          channel: "dev" as const,
          bundleDigest: manifest.bundleDigest,
          policyDigest: manifest.policyDigest,
          providers: {
            codex: { adapterDigest: manifest.adapterDigest, minimumVersion: "0.144.0" },
            "claude-code": { adapterDigest: `sha256:${"4".repeat(64)}`, minimumVersion: "2.1.121" },
          },
        },
      },
      probe: probe(false),
      marketplaceName: "first-tree-dev",
    };
    let journalDuringMutation: unknown;

    expect(() =>
      repairContextIntegrationOperation(provider.value, plan, {
        install: () => {
          journalDuringMutation = JSON.parse(
            readFileSync(join(home, "state", "context", "operation-journal.json"), "utf8"),
          );
          throw new Error("provider process interrupted");
        },
      }),
    ).toThrow("provider process interrupted");

    expect(journalDuringMutation).toMatchObject({
      accountClientId: "client_1234abcd",
      operation: "repair",
      phase: "prepared",
      providerInstalled: false,
    });
    expect(provider.uninstall).toHaveBeenCalled();
    expect(existsSync(join(home, "state", "context", "operation-journal.json"))).toBe(false);
  });

  it("recovers a crashed provider update from the durable operation snapshot", () => {
    const home = setupHome("first-tree-context-operation-recovery-");
    const provider = driver(false);
    const manifest = installManifest();
    const binding = {
      provider: "codex" as const,
      checkoutRoot: "/work/payments",
      repositoryKey: "github.com/acme/payments",
      organizationId: "org-acme",
    };
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    const recoveryMarketplaceRoot = join(recoveryRoot, "marketplace");
    writeRollbackPlugin(recoveryMarketplaceRoot);
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "repair",
        phase: "provider_changed",
        previousBindings: [binding],
        previousInstallManifest: manifest,
        providerInstalled: true,
        providerEnabled: true,
        marketplaceSourceExisted: true,
        recoveryMarketplaceRoot,
        startedAt: "2026-07-28T00:00:00.000Z",
      })}\n`,
    );

    expect(recoverContextIntegrationOperation(provider.value)).toBe(true);
    expect(readContextIntegrationConfig().bindings).toEqual([binding]);
    expect(provider.install).toHaveBeenCalled();
    expect(existsSync(join(home, "state", "context", "operation-journal.json"))).toBe(false);
    expect(existsSync(recoveryRoot)).toBe(false);
  });

  it("keeps a durable recovery snapshot when retrying the old provider install fails", () => {
    const home = setupHome("first-tree-context-operation-retry-");
    const provider = driver(false);
    provider.install.mockImplementation(() => {
      throw new Error("provider still unavailable");
    });
    const manifest = installManifest();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    const recoveryMarketplaceRoot = join(recoveryRoot, "marketplace");
    writeRollbackPlugin(recoveryMarketplaceRoot);
    mkdirSync(join(home, "state", "context"), { recursive: true });
    const journalPath = join(home, "state", "context", "operation-journal.json");
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 1,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "repair",
        phase: "rollback_failed",
        previousBindings: [],
        previousInstallManifest: manifest,
        providerInstalled: true,
        providerEnabled: true,
        marketplaceSourceExisted: true,
        recoveryMarketplaceRoot,
        startedAt: "2026-07-28T00:00:00.000Z",
      })}\n`,
    );

    expect(() => recoverContextIntegrationOperation(provider.value)).toThrow(
      "Could not recover the incomplete First Tree Context operation",
    );
    expect(existsSync(journalPath)).toBe(true);
    expect(existsSync(recoveryMarketplaceRoot)).toBe(true);
  });

  it("rejects recovery after the active local account identity changes", () => {
    const home = setupHome("first-tree-context-operation-account-");
    const provider = driver(false);
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    mkdirSync(recoveryRoot, { recursive: true });
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        operationId,
        accountClientId: "client_deadbeef",
        provider: "codex",
        operation: "enable",
        phase: "prepared",
        previousBindings: [],
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        startedAt: "2026-07-28T00:00:00.000Z",
      })}\n`,
    );

    expect(() => recoverContextIntegrationOperation(provider.value)).toThrow("different local First Tree Computer");
    expect(provider.install).not.toHaveBeenCalled();
    expect(provider.uninstall).not.toHaveBeenCalled();
  });
});
