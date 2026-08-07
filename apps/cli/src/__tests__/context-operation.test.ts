import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contextGrantStoreFingerprintAfterGrant,
  inspectContextGrantStore,
  readContextIntegrationConfig,
} from "../core/context-integration/context-binding-store.js";
import { contextIntegrationMarketplaceSourcePath } from "../core/context-integration/installer.js";
import { writeContextIntegrationInstallManifest } from "../core/context-integration/manifest.js";
import {
  contextOperationObservationSnapshotDigest,
  disableContextIntegrationOperation,
  enableContextIntegrationOperation,
  recoverContextIntegrationOperation,
} from "../core/context-integration/operation.js";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";

const original = process.env.FIRST_TREE_HOME;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (original === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = original;
});

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), "context-operation-v3-"));
  roots.push(root);
  process.env.FIRST_TREE_HOME = root;
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  return root;
}

function grant() {
  return { provider: "codex" as const, organizationId: "org-a", activationScope: { kind: "global" as const } };
}

function storeFence(target = grant()) {
  const store = inspectContextGrantStore();
  return {
    beforeFingerprint: store.fingerprint,
    afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, target),
  };
}

function installManifest() {
  return {
    schemaVersion: 1 as const,
    channel: "dev" as const,
    provider: "codex" as const,
    firstTreeVersion: "0.5.18",
    bundleVersion: "0.5.18",
    bundleDigest: `sha256:${"1".repeat(64)}`,
    policyDigest: `sha256:${"2".repeat(64)}`,
    adapterDigest: `sha256:${"3".repeat(64)}`,
    marketplaceName: "first-tree-dev",
    pluginName: "first-tree-context",
    installedAt: "2026-08-03T00:00:00.000Z",
  };
}

function seedRollbackPlugin(): void {
  const root = join(contextIntegrationMarketplaceSourcePath("codex"), "plugins", "first-tree-context");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "context-session-start"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
}

function seedCurrentGrantAndStableSource(): void {
  const target = grant();
  enableContextIntegrationOperation(driver, unchangedPlan, target, storeFence(target), "client_1234abcd");
  seedRollbackPlugin();
}

const driver: ContextIntegrationProviderDriver = {
  provider: "codex",
  executable: "codex",
  minimumVersion: "0.144.0",
  probe: () => ({
    provider: "codex",
    binaryAvailable: true,
    version: "0.145.0",
    compatible: true,
    installed: false,
    enabled: false,
    installedPath: null,
    issues: [],
  }),
  inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
  validateMarketplace: () => undefined,
  install: () => {
    throw new Error("not expected");
  },
  uninstall: () => undefined,
};

function testClaudeDriver(): ContextIntegrationProviderDriver {
  return {
    ...driver,
    provider: "claude-code",
    executable: "claude",
    minimumVersion: "2.1.121",
    probe: () => ({
      provider: "claude-code",
      binaryAvailable: true,
      version: "2.1.121",
      compatible: true,
      installed: false,
      enabled: false,
      installedPath: null,
      issues: [],
    }),
  };
}

const unchangedPlan = {
  provider: "codex" as const,
  operation: "unchanged" as const,
  previous: null,
  release: {
    root: "/unused",
    coreRoot: "/unused",
    manifest: {
      schemaVersion: 1 as const,
      version: "0.5.18",
      channel: "dev" as const,
      bundleDigest: `sha256:${"1".repeat(64)}`,
      policyDigest: `sha256:${"2".repeat(64)}`,
      core: {
        digest: `sha256:${"5".repeat(64)}`,
        policy: { path: "policy.md", digest: `sha256:${"2".repeat(64)}` },
        skills: {
          "first-tree-read": { path: "read.md", digest: `sha256:${"6".repeat(64)}` },
          "first-tree-write": { path: "write.md", digest: `sha256:${"7".repeat(64)}` },
        },
      },
      providers: {
        codex: { adapterVersion: "1.0.0", adapterDigest: `sha256:${"3".repeat(64)}`, minimumVersion: "0.144.0" },
        "claude-code": {
          adapterVersion: "1.0.0",
          adapterDigest: `sha256:${"4".repeat(64)}`,
          minimumVersion: "2.1.121",
        },
      },
    },
  },
  probe: driver.probe("first-tree", "first-tree-context"),
  marketplaceName: "first-tree-dev",
};

describe("v3 grant operation", () => {
  it("atomically adds and removes one exact grant", () => {
    setup();
    const grant = { provider: "codex" as const, organizationId: "org-a", activationScope: { kind: "global" as const } };
    const store = inspectContextGrantStore();
    enableContextIntegrationOperation(
      driver,
      unchangedPlan,
      grant,
      {
        beforeFingerprint: store.fingerprint,
        afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, grant),
      },
      "client_1234abcd",
    );
    expect(readContextIntegrationConfig().grants).toEqual([grant]);
    disableContextIntegrationOperation("codex", {
      organizationId: "org-a",
      activationScope: { kind: "global" },
      expectedConfig: readContextIntegrationConfig(),
      expectedAccountClientId: "client_1234abcd",
    });
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 3, grants: [] });
  });

  it("removes only the exact Team and scope while preserving peer grants", () => {
    setup();
    const first = grant();
    const second = {
      provider: "codex" as const,
      organizationId: "org-b",
      activationScope: { kind: "directory" as const, root: "/work/other" },
    };
    for (const target of [first, second]) {
      const store = inspectContextGrantStore();
      enableContextIntegrationOperation(
        driver,
        unchangedPlan,
        target,
        {
          beforeFingerprint: store.fingerprint,
          afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, target),
        },
        "client_1234abcd",
      );
    }
    const before = readContextIntegrationConfig();
    const result = disableContextIntegrationOperation("codex", {
      organizationId: first.organizationId,
      activationScope: first.activationScope,
      expectedConfig: before,
      expectedAccountClientId: "client_1234abcd",
    });
    expect(result.removed).toEqual([first]);
    expect(result.remaining).toEqual([second]);
    expect(readContextIntegrationConfig().grants).toEqual([second]);
  });

  it("fails before mutation when the installed provider Plugin is disabled", () => {
    setup();
    writeContextIntegrationInstallManifest(installManifest());
    seedRollbackPlugin();
    const install = vi.fn();
    const uninstall = vi.fn();
    const disabled: ContextIntegrationProviderDriver = {
      ...driver,
      probe: () => ({
        ...driver.probe("first-tree-dev", "first-tree-context"),
        installed: true,
        enabled: false,
        installedPath: "/provider/plugin",
      }),
      install,
      uninstall,
    };
    expect(() =>
      enableContextIntegrationOperation(disabled, unchangedPlan, grant(), storeFence(), "client_1234abcd"),
    ).toThrow("installed but disabled");
    expect(install).not.toHaveBeenCalled();
    expect(uninstall).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig().grants).toEqual([]);
  });

  it("rejects a stale grant plan before provider mutation", () => {
    setup();
    const target = grant();
    const fence = storeFence(target);
    const concurrent = {
      provider: "codex" as const,
      organizationId: "org-b",
      activationScope: { kind: "global" as const },
    };
    const current = inspectContextGrantStore();
    enableContextIntegrationOperation(
      driver,
      unchangedPlan,
      concurrent,
      {
        beforeFingerprint: current.fingerprint,
        afterFingerprint: contextGrantStoreFingerprintAfterGrant(current, concurrent),
      },
      "client_1234abcd",
    );
    const install = vi.fn();
    expect(() =>
      enableContextIntegrationOperation({ ...driver, install }, unchangedPlan, target, fence, "client_1234abcd"),
    ).toThrow("changed after the displayed plan");
    expect(install).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig().grants).toEqual([concurrent]);
  });

  it("rolls back Plugin, manifest, and grants when grant persistence fails", () => {
    const home = setup();
    const target = grant();
    const uninstall = vi.fn();
    const installing = { ...driver, uninstall };
    const plan = { ...unchangedPlan, operation: "install" as const };
    expect(() =>
      enableContextIntegrationOperation(installing, plan, target, storeFence(target), "client_1234abcd", {
        install: () => {
          writeContextIntegrationInstallManifest(installManifest());
          return { manifest: installManifest(), probe: driver.probe("first-tree-dev", "first-tree-context") };
        },
        writeGrant: () => {
          throw new Error("grant rename failed");
        },
      }),
    ).toThrow("grant rename failed");
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(readContextIntegrationConfig().grants).toEqual([]);
    expect(existsSync(join(home, "state", "context", "operation-journal.json"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "rejects a dangling observation symlink before provider or grant mutation",
    () => {
      const home = setup();
      const providerRoot = join(home, "state", "context", "providers", "claude-code");
      mkdirSync(providerRoot, { recursive: true });
      const evidence = join(providerRoot, "reload-required.json");
      symlinkSync(join(home, "missing-reload-state"), evidence);
      const claudeDriver = testClaudeDriver();
      const target = {
        provider: "claude-code" as const,
        organizationId: "org-a",
        activationScope: { kind: "global" as const },
      };
      const store = inspectContextGrantStore();
      const install = vi.fn();
      const writeGrant = vi.fn();

      expect(() =>
        enableContextIntegrationOperation(
          claudeDriver,
          {
            ...unchangedPlan,
            provider: "claude-code",
            operation: "install",
            probe: claudeDriver.probe("first-tree-dev", "first-tree-context"),
          },
          target,
          {
            beforeFingerprint: store.fingerprint,
            afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, target),
          },
          "client_1234abcd",
          { install, writeGrant },
        ),
      ).toThrow("invalid reload-required.json entry");
      expect(install).not.toHaveBeenCalled();
      expect(writeGrant).not.toHaveBeenCalled();
      expect(lstatSync(evidence).isSymbolicLink()).toBe(true);
      expect(readContextIntegrationConfig().grants).toEqual([]);
    },
  );

  it("restores the exact Claude observation state when grant persistence fails after install", () => {
    const home = setup();
    const providerRoot = join(home, "state", "context", "providers", "claude-code");
    const oldPending = join(providerRoot, "reload-pending", `${"a".repeat(64)}.json`);
    const oldConsumed = join(providerRoot, "reload-consumed", `${"b".repeat(48)}.json`);
    const oldNextSession = join(providerRoot, "next-session-required.json");
    mkdirSync(join(oldPending, ".."), { recursive: true });
    mkdirSync(join(oldConsumed, ".."), { recursive: true });
    writeFileSync(oldPending, "old pending\n");
    writeFileSync(oldConsumed, "old consumed\n");
    writeFileSync(oldNextSession, "old next session\n");
    const claudeDriver = testClaudeDriver();
    const target = {
      provider: "claude-code" as const,
      organizationId: "org-a",
      activationScope: { kind: "global" as const },
    };
    const plan = {
      ...unchangedPlan,
      provider: "claude-code" as const,
      operation: "install" as const,
      probe: claudeDriver.probe("first-tree-dev", "first-tree-context"),
    };
    const store = inspectContextGrantStore();

    expect(() =>
      enableContextIntegrationOperation(
        claudeDriver,
        plan,
        target,
        {
          beforeFingerprint: store.fingerprint,
          afterFingerprint: contextGrantStoreFingerprintAfterGrant(store, target),
        },
        "client_1234abcd",
        {
          install: () => {
            rmSync(join(providerRoot, "reload-pending"), { recursive: true, force: true });
            rmSync(join(providerRoot, "reload-consumed"), { recursive: true, force: true });
            writeFileSync(join(providerRoot, "reload-required.json"), "new marker\n");
            writeFileSync(join(providerRoot, "next-session-required.json"), "new next session\n");
            const manifest = {
              ...installManifest(),
              provider: "claude-code" as const,
              adapterDigest: `sha256:${"4".repeat(64)}`,
              adoptionGeneration: "c".repeat(48),
            };
            writeContextIntegrationInstallManifest(manifest);
            return { manifest, probe: claudeDriver.probe("first-tree-dev", "first-tree-context") };
          },
          writeGrant: () => {
            throw new Error("grant rename failed");
          },
        },
      ),
    ).toThrow("grant rename failed");

    expect(readFileSync(oldPending, "utf8")).toBe("old pending\n");
    expect(readFileSync(oldConsumed, "utf8")).toBe("old consumed\n");
    expect(readFileSync(oldNextSession, "utf8")).toBe("old next session\n");
    expect(existsSync(join(providerRoot, "reload-required.json"))).toBe(false);
  });

  it("recovers Claude observation state after a provider_changed crash", () => {
    const home = setup();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    const recoveryObservationRoot = join(recoveryRoot, "observation");
    const providerRoot = join(home, "state", "context", "providers", "claude-code");
    mkdirSync(join(recoveryObservationRoot, "reload-pending"), { recursive: true });
    writeFileSync(join(recoveryObservationRoot, "reload-pending", `${"d".repeat(64)}.json`), "previous\n");
    writeFileSync(join(recoveryObservationRoot, "next-session-required.json"), "previous next session\n");
    mkdirSync(providerRoot, { recursive: true });
    writeFileSync(join(providerRoot, "reload-required.json"), "new marker\n");
    writeFileSync(join(providerRoot, "next-session-required.json"), "new next session\n");
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      `${JSON.stringify({
        schemaVersion: 3,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "claude-code",
        operation: "enable",
        phase: "provider_changed",
        previousConfig: { schemaVersion: 3, grants: [] },
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        recoveryObservationRoot,
        recoveryObservationDigest: contextOperationObservationSnapshotDigest(recoveryObservationRoot),
        startedAt: "2026-08-05T00:00:00.000Z",
      })}\n`,
    );

    expect(recoverContextIntegrationOperation(testClaudeDriver())).toBe(true);
    expect(readFileSync(join(providerRoot, "reload-pending", `${"d".repeat(64)}.json`), "utf8")).toBe("previous\n");
    expect(readFileSync(join(providerRoot, "next-session-required.json"), "utf8")).toBe("previous next session\n");
    expect(existsSync(join(providerRoot, "reload-required.json"))).toBe(false);
  });

  it("fails before any recovery mutation when a schema-3 observation snapshot loses a child", () => {
    const home = setup();
    const currentGrant = grant();
    enableContextIntegrationOperation(driver, unchangedPlan, currentGrant, storeFence(currentGrant), "client_1234abcd");
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    const recoveryObservationRoot = join(recoveryRoot, "observation");
    const snapshotChild = join(recoveryObservationRoot, "reload-pending", `${"e".repeat(64)}.json`);
    const providerRoot = join(home, "state", "context", "providers", "claude-code");
    mkdirSync(join(snapshotChild, ".."), { recursive: true });
    writeFileSync(snapshotChild, "previous pending\n");
    const recoveryObservationDigest = contextOperationObservationSnapshotDigest(recoveryObservationRoot);
    mkdirSync(providerRoot, { recursive: true });
    writeFileSync(join(providerRoot, "reload-required.json"), "live marker\n");
    mkdirSync(join(home, "state", "context"), { recursive: true });
    const journalPath = join(home, "state", "context", "operation-journal.json");
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 3,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "claude-code",
        operation: "enable",
        phase: "provider_changed",
        previousConfig: { schemaVersion: 3, grants: [] },
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        recoveryObservationRoot,
        recoveryObservationDigest,
        startedAt: "2026-08-05T00:00:00.000Z",
      })}\n`,
    );
    rmSync(snapshotChild, { force: true });
    const uninstall = vi.fn();

    expect(() => recoverContextIntegrationOperation({ ...testClaudeDriver(), uninstall })).toThrow(
      "Invalid First Tree Context operation journal",
    );
    expect(uninstall).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig().grants).toEqual([currentGrant]);
    expect(readFileSync(join(providerRoot, "reload-required.json"), "utf8")).toBe("live marker\n");
    expect(existsSync(journalPath)).toBe(true);
  });

  it("keeps a rollback_failed durable journal when restoration also fails", () => {
    const home = setup();
    const target = grant();
    const failing = {
      ...driver,
      uninstall: vi.fn(() => {
        throw new Error("provider rollback failed");
      }),
    };
    expect(() =>
      enableContextIntegrationOperation(
        failing,
        { ...unchangedPlan, operation: "install" as const },
        target,
        storeFence(target),
        "client_1234abcd",
        {
          install: () => ({ manifest: installManifest(), probe: driver.probe("first-tree-dev", "first-tree-context") }),
          writeGrant: () => {
            throw new Error("grant failed");
          },
        },
      ),
    ).toThrow(AggregateError);
    expect(JSON.parse(readFileSync(join(home, "state", "context", "operation-journal.json"), "utf8"))).toMatchObject({
      phase: "rollback_failed",
      previousConfig: { schemaVersion: 3, grants: [] },
    });
  });

  it("recovers the exact previous v3 grant set from a durable journal", () => {
    const home = setup();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    mkdirSync(recoveryRoot, { recursive: true });
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "enable",
        phase: "grant_changed",
        previousConfig: { schemaVersion: 3, grants: [grant()] },
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        startedAt: "2026-08-03T00:00:00.000Z",
      })}\n`,
    );
    expect(recoverContextIntegrationOperation(driver)).toBe(true);
    expect(readContextIntegrationConfig().grants).toEqual([grant()]);
    expect(existsSync(recoveryRoot)).toBe(false);
  });

  it("retires and backs up a published schema-v1 journal with v2 bindings during recovery", () => {
    const home = setup();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    mkdirSync(recoveryRoot, { recursive: true });
    mkdirSync(join(home, "state", "context"), { recursive: true });
    const legacyBinding = {
      provider: "codex",
      project: { kind: "path", root: "/work/legacy" },
      organizationId: "org-legacy",
    };
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "enable",
        phase: "binding_changed",
        previousBindings: [legacyBinding],
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        startedAt: "2026-08-03T00:00:00.000Z",
      })}\n`,
    );
    const uninstall = vi.fn();
    expect(recoverContextIntegrationOperation({ ...driver, uninstall })).toBe(true);
    expect(uninstall).toHaveBeenCalledTimes(1);
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 3, grants: [] });
    expect(readFileSync(join(home, "config", "context.yaml.v2.bak"), "utf8")).toContain("org-legacy");
    expect(existsSync(recoveryRoot)).toBe(false);
  });

  it.each([
    {
      name: "installed provider without its manifest and recovery source",
      state: {
        previousInstallManifest: null,
        providerInstalled: true,
        providerEnabled: true,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
      },
    },
    {
      name: "marketplace recovery path outside the operation root",
      state: {
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: true,
        recoveryMarketplaceRoot: "/tmp/escaped-marketplace",
      },
    },
  ])("rejects $name before any recovery mutation", ({ state }) => {
    const home = setup();
    seedCurrentGrantAndStableSource();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    mkdirSync(join(home, "state", "context", "operation-recovery", operationId), { recursive: true });
    mkdirSync(join(home, "state", "context"), { recursive: true });
    writeFileSync(
      join(home, "state", "context", "operation-journal.json"),
      `${JSON.stringify({
        schemaVersion: 2,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "enable",
        phase: "rollback_failed",
        previousConfig: { schemaVersion: 3, grants: [] },
        startedAt: "2026-08-03T00:00:00.000Z",
        ...state,
      })}\n`,
    );
    const uninstall = vi.fn();
    expect(() => recoverContextIntegrationOperation({ ...driver, uninstall })).toThrow(
      "Invalid First Tree Context operation journal",
    );
    expect(uninstall).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 3, grants: [grant()] });
    expect(existsSync(contextIntegrationMarketplaceSourcePath("codex"))).toBe(true);
    expect(existsSync(join(home, "state", "context", "operation-journal.json"))).toBe(true);
  });

  it.each([
    {
      name: "schema-v1 previousBindings",
      journal: {
        schemaVersion: 1,
        phase: "binding_changed",
      },
    },
    {
      name: "schema-v2 previousConfig.grants",
      journal: {
        schemaVersion: 2,
        phase: "grant_changed",
        previousConfig: { schemaVersion: 3 },
      },
    },
  ])("rejects a journal missing required $name before any recovery mutation", ({ journal }) => {
    const home = setup();
    seedCurrentGrantAndStableSource();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    mkdirSync(join(home, "state", "context", "operation-recovery", operationId), { recursive: true });
    const journalPath = join(home, "state", "context", "operation-journal.json");
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "enable",
        previousInstallManifest: null,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: false,
        recoveryMarketplaceRoot: null,
        startedAt: "2026-08-03T00:00:00.000Z",
        ...journal,
      })}\n`,
    );
    const uninstall = vi.fn();
    expect(() => recoverContextIntegrationOperation({ ...driver, uninstall })).toThrow(
      "Invalid First Tree Context operation journal",
    );
    expect(uninstall).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 3, grants: [grant()] });
    expect(existsSync(contextIntegrationMarketplaceSourcePath("codex"))).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it.each([
    {
      name: "missing exact marketplace recovery directory",
      prepare: (_home: string, _recoveryRoot: string) => undefined,
      previousInstallManifest: installManifest(),
    },
    {
      name: "manifest for another provider",
      prepare: (_home: string, recoveryRoot: string) => mkdirSync(join(recoveryRoot, "marketplace")),
      previousInstallManifest: { ...installManifest(), provider: "claude-code" as const },
    },
  ])("rejects $name before uninstalling the current provider", ({ prepare, previousInstallManifest }) => {
    const home = setup();
    seedCurrentGrantAndStableSource();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    mkdirSync(recoveryRoot, { recursive: true });
    prepare(home, recoveryRoot);
    const journalPath = join(home, "state", "context", "operation-journal.json");
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 2,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "enable",
        phase: "rollback_failed",
        previousConfig: { schemaVersion: 3, grants: [] },
        previousInstallManifest,
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: true,
        recoveryMarketplaceRoot: join(recoveryRoot, "marketplace"),
        startedAt: "2026-08-03T00:00:00.000Z",
      })}\n`,
    );
    const uninstall = vi.fn();
    expect(() => recoverContextIntegrationOperation({ ...driver, uninstall })).toThrow(
      "Invalid First Tree Context operation journal",
    );
    expect(uninstall).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 3, grants: [grant()] });
    expect(existsSync(contextIntegrationMarketplaceSourcePath("codex"))).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it.runIf(process.platform !== "win32")("rejects a symlink marketplace recovery source before mutation", () => {
    const home = setup();
    seedCurrentGrantAndStableSource();
    const operationId = "12345678-1234-4123-8123-123456789abc";
    const recoveryRoot = join(home, "state", "context", "operation-recovery", operationId);
    const escaped = join(home, "escaped-marketplace");
    mkdirSync(recoveryRoot, { recursive: true });
    mkdirSync(escaped, { recursive: true });
    symlinkSync(escaped, join(recoveryRoot, "marketplace"), "dir");
    const journalPath = join(home, "state", "context", "operation-journal.json");
    writeFileSync(
      journalPath,
      `${JSON.stringify({
        schemaVersion: 2,
        operationId,
        accountClientId: "client_1234abcd",
        provider: "codex",
        operation: "enable",
        phase: "rollback_failed",
        previousConfig: { schemaVersion: 3, grants: [] },
        previousInstallManifest: installManifest(),
        providerInstalled: false,
        providerEnabled: false,
        marketplaceSourceExisted: true,
        recoveryMarketplaceRoot: join(recoveryRoot, "marketplace"),
        startedAt: "2026-08-03T00:00:00.000Z",
      })}\n`,
    );
    const uninstall = vi.fn();
    expect(() => recoverContextIntegrationOperation({ ...driver, uninstall })).toThrow(
      "Invalid First Tree Context operation journal",
    );
    expect(uninstall).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig()).toEqual({ schemaVersion: 3, grants: [grant()] });
    expect(existsSync(contextIntegrationMarketplaceSourcePath("codex"))).toBe(true);
    expect(existsSync(journalPath)).toBe(true);
  });

  it("rejects account changes before any operation mutation", () => {
    setup();
    const target = grant();
    const install = vi.fn();
    expect(() =>
      enableContextIntegrationOperation(
        { ...driver, install },
        unchangedPlan,
        target,
        storeFence(target),
        "client_other",
      ),
    ).toThrow("account changed");
    expect(install).not.toHaveBeenCalled();
    expect(readContextIntegrationConfig().grants).toEqual([]);
  });
});
