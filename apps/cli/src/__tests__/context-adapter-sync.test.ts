import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginContextAdapterNextSessionObligation,
  inspectContextAdapterNextSessionObligation,
} from "../core/context-integration/adapter-observation.js";
import {
  AdapterNextSessionRequiredError,
  hasKnownCompatibleContextAdapterSession,
  hasKnownGoodCompatibleContextAdapter,
  issueAdapterSyncAction,
  synchronizeContextAdapter,
} from "../core/context-integration/adapter-sync.js";
import {
  readContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "../core/context-integration/manifest.js";
import { repairContextIntegrationOperation } from "../core/context-integration/operation.js";
import { contextPluginTreeDigest } from "../core/context-integration/payload-integrity.js";
import type { ContextIntegrationProviderDriver } from "../core/context-integration/provider-driver.js";
import { resolveContextIntegrationRelease } from "../core/context-integration/release.js";
import { COMMAND_VERSION } from "../core/version.js";

const roots: string[] = [];
const originalHome = process.env.FIRST_TREE_HOME;
let home = "";
let releaseRoot = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "first-tree-adapter-sync-home-"));
  releaseRoot = mkdtempSync(join(tmpdir(), "first-tree-adapter-sync-release-"));
  roots.push(home, releaseRoot);
  process.env.FIRST_TREE_HOME = home;
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
  buildRelease(releaseRoot);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.FIRST_TREE_HOME;
  else process.env.FIRST_TREE_HOME = originalHome;
});

describe("lazy Context adapter sync", () => {
  it("issues a session-bound forward-only action and consumes it idempotently in a normal turn", () => {
    const fixture = prepareOldCompatibleInstall();
    const action = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-a", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    const repair = vi.fn(() => {
      writeContextIntegrationInstallManifest({
        ...fixture.previous,
        adapterVersion: fixture.target.adapterVersion,
        adapterDigest: fixture.target.adapterDigest,
      });
    });

    const result = synchronizeContextAdapter(driver("claude-code"), action.challenge, {
      releaseRoot,
      planInstall: () => fixture.plan,
      repairOperation: repair,
    });

    expect(result).toMatchObject({ updated: true, currentSessionAdoption: "next_session" });
    expect(repair).toHaveBeenCalledOnce();
    expect(
      synchronizeContextAdapter(driver("claude-code"), action.challenge, {
        releaseRoot,
        planInstall: () => fixture.plan,
        repairOperation: repair,
      }),
    ).toMatchObject({ updated: true, currentSessionAdoption: "next_session" });
    expect(repair).toHaveBeenCalledOnce();
  });

  it("keeps the exact upgraded Claude session compatible across later lifecycle events", () => {
    const fixture = prepareOldCompatibleInstall();
    const action = issueAdapterSyncAction(
      {
        provider: "claude-code",
        sessionId: "session-lifecycle",
        suppliedAdapterDigest: fixture.previous.adapterDigest,
      },
      { releaseRoot, driver: driver("claude-code") },
    );
    const repair = vi.fn(() => {
      writeContextIntegrationInstallManifest({
        ...fixture.previous,
        adapterVersion: fixture.target.adapterVersion,
        adapterDigest: fixture.target.adapterDigest,
      });
    });

    synchronizeContextAdapter(driver("claude-code"), action.challenge, {
      releaseRoot,
      planInstall: () => fixture.plan,
      repairOperation: repair,
    });

    expect(
      hasKnownCompatibleContextAdapterSession(
        {
          provider: "claude-code",
          sessionId: "session-lifecycle",
          suppliedAdapterDigest: fixture.previous.adapterDigest,
        },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toBe(true);
    expect(
      hasKnownCompatibleContextAdapterSession(
        {
          provider: "claude-code",
          sessionId: "another-session",
          suppliedAdapterDigest: fixture.previous.adapterDigest,
        },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toBe(false);
    expect(
      hasKnownCompatibleContextAdapterSession(
        {
          provider: "claude-code",
          sessionId: "session-lifecycle",
          suppliedAdapterDigest: `sha256:${"f".repeat(64)}`,
        },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toBe(false);
  });

  it("preserves concurrent old Claude sessions when the first sync replaces the global Plugin", () => {
    const fixture = prepareOldCompatibleInstall();
    const first = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-a", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    const second = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-b", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    const repair = vi.fn(() => {
      rmSync(join(home, "state", "context", "providers", "claude-code", "adapter-sync"), {
        recursive: true,
        force: true,
      });
      writeContextIntegrationInstallManifest({
        ...fixture.previous,
        adapterVersion: fixture.target.adapterVersion,
        adapterDigest: fixture.target.adapterDigest,
      });
    });

    synchronizeContextAdapter(driver("claude-code"), first.challenge, {
      releaseRoot,
      planInstall: () => fixture.plan,
      repairOperation: repair,
    });

    for (const sessionId of ["session-a", "session-b"]) {
      expect(
        hasKnownCompatibleContextAdapterSession(
          { provider: "claude-code", sessionId, suppliedAdapterDigest: fixture.previous.adapterDigest },
          { releaseRoot, driver: driver("claude-code") },
        ),
      ).toBe(true);
    }
    expect(
      synchronizeContextAdapter(driver("claude-code"), second.challenge, {
        releaseRoot,
        repairOperation: vi.fn(() => {
          throw new Error("the second action must reuse the completed global update");
        }),
      }),
    ).toMatchObject({ updated: true, currentSessionAdoption: "next_session" });
    expect(repair).toHaveBeenCalledOnce();
  });

  it("preserves a Claude action issued after receipt collection but before global Plugin mutation", () => {
    const fixture = prepareOldCompatibleInstall();
    const first = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-a", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    const interleaved: { action?: ReturnType<typeof issueAdapterSyncAction> } = {};
    const repair = vi.fn(() => {
      rmSync(join(home, "state", "context", "providers", "claude-code", "adapter-sync"), {
        recursive: true,
        force: true,
      });
      writeContextIntegrationInstallManifest({
        ...fixture.previous,
        adapterVersion: fixture.target.adapterVersion,
        adapterDigest: fixture.target.adapterDigest,
      });
    });

    synchronizeContextAdapter(driver("claude-code"), first.challenge, {
      releaseRoot,
      planInstall: () => {
        interleaved.action = issueAdapterSyncAction(
          { provider: "claude-code", sessionId: "session-c", suppliedAdapterDigest: fixture.previous.adapterDigest },
          { releaseRoot, driver: driver("claude-code") },
        );
        return fixture.plan;
      },
      repairOperation: repair,
    });

    const interleavedAction = interleaved.action;
    expect(interleavedAction).toBeDefined();
    if (!interleavedAction) throw new Error("interleaved action was not issued");
    expect(
      hasKnownCompatibleContextAdapterSession(
        {
          provider: "claude-code",
          sessionId: "session-c",
          suppliedAdapterDigest: fixture.previous.adapterDigest,
        },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toBe(true);
    expect(
      synchronizeContextAdapter(driver("claude-code"), interleavedAction.challenge, {
        releaseRoot,
        repairOperation: vi.fn(() => {
          throw new Error("interleaved action must reuse the committed target");
        }),
      }),
    ).toMatchObject({ updated: true, currentSessionAdoption: "next_session" });
  });

  it("rejects an old sync action replay after another repair requires next-session adoption", () => {
    const fixture = prepareOldCompatibleInstall();
    const action = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-old", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    writeContextIntegrationInstallManifest({
      ...fixture.previous,
      adapterVersion: fixture.target.adapterVersion,
      adapterDigest: fixture.target.adapterDigest,
    });
    beginContextAdapterNextSessionObligation(fixture.release.manifest, "standalone_repair");

    expect(inspectContextAdapterNextSessionObligation()).toBe("standalone_repair");
    expect(hasKnownGoodCompatibleContextAdapter(driver("claude-code"))).toBe(false);
    expect(() =>
      synchronizeContextAdapter(driver("claude-code"), action.challenge, {
        releaseRoot,
        repairOperation: vi.fn(() => {
          throw new Error("pending adoption must block replay before mutation");
        }),
      }),
    ).toThrow(AdapterNextSessionRequiredError);
    expect(
      hasKnownCompatibleContextAdapterSession(
        {
          provider: "claude-code",
          sessionId: "session-old",
          suppliedAdapterDigest: fixture.previous.adapterDigest,
        },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toBe(false);
  });

  it("preserves an action issued after the operation snapshot when the provider update rolls back", () => {
    const fixture = prepareOldCompatibleInstall();
    const first = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-a", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    let concurrent: ReturnType<typeof issueAdapterSyncAction> | undefined;
    const rollbackDriver = driver("claude-code");
    rollbackDriver.install = () => rollbackDriver.probe("first-tree-dev", "first-tree-context");

    expect(() =>
      synchronizeContextAdapter(rollbackDriver, first.challenge, {
        releaseRoot,
        planInstall: () => fixture.plan,
        repairOperation: (providerDriver, plan) =>
          repairContextIntegrationOperation(providerDriver, plan, {
            install: () => {
              concurrent = issueAdapterSyncAction(
                {
                  provider: "claude-code",
                  sessionId: "session-after-snapshot",
                  suppliedAdapterDigest: fixture.previous.adapterDigest,
                },
                { releaseRoot, driver: rollbackDriver },
              );
              throw new Error("provider update failed after concurrent issuance");
            },
          }),
      }),
    ).toThrow("provider update failed after concurrent issuance");

    const concurrentAction = concurrent;
    expect(concurrentAction).toBeDefined();
    if (!concurrentAction) throw new Error("concurrent action was not issued");
    expect(readContextIntegrationInstallManifest("claude-code")?.adapterDigest).toBe(fixture.previous.adapterDigest);

    expect(
      synchronizeContextAdapter(driver("claude-code"), concurrentAction.challenge, {
        releaseRoot,
        planInstall: () => fixture.plan,
        repairOperation: () => {
          writeContextIntegrationInstallManifest({
            ...fixture.previous,
            adapterVersion: fixture.target.adapterVersion,
            adapterDigest: fixture.target.adapterDigest,
          });
        },
      }),
    ).toMatchObject({ updated: true, currentSessionAdoption: "next_session" });
    expect(
      hasKnownCompatibleContextAdapterSession(
        {
          provider: "claude-code",
          sessionId: "session-after-snapshot",
          suppliedAdapterDigest: fixture.previous.adapterDigest,
        },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toBe(true);
  });

  it("activates the prepared session fact if the process exits after the provider update commits", () => {
    const fixture = prepareOldCompatibleInstall();
    const action = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-crash", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    const committedThenExited = vi.fn(() => {
      rmSync(join(home, "state", "context", "providers", "claude-code", "adapter-sync"), {
        recursive: true,
        force: true,
      });
      writeContextIntegrationInstallManifest({
        ...fixture.previous,
        adapterVersion: fixture.target.adapterVersion,
        adapterDigest: fixture.target.adapterDigest,
      });
      throw new Error("simulated process exit after provider commit");
    });

    expect(() =>
      synchronizeContextAdapter(driver("claude-code"), action.challenge, {
        releaseRoot,
        planInstall: () => fixture.plan,
        repairOperation: committedThenExited,
      }),
    ).toThrow("simulated process exit");
    expect(
      hasKnownCompatibleContextAdapterSession(
        {
          provider: "claude-code",
          sessionId: "session-crash",
          suppliedAdapterDigest: fixture.previous.adapterDigest,
        },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toBe(true);
    expect(
      synchronizeContextAdapter(driver("claude-code"), action.challenge, {
        releaseRoot,
        repairOperation: vi.fn(() => {
          throw new Error("recovery must use the already committed exact target");
        }),
      }),
    ).toMatchObject({ updated: true, currentSessionAdoption: "next_session" });
  });

  it("retains the exact action after a rolled-back update so a bounded retry can succeed", () => {
    const fixture = prepareOldCompatibleInstall();
    const action = issueAdapterSyncAction(
      { provider: "codex", sessionId: "thread-a", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("codex") },
    );
    const failedRepair = vi.fn(() => {
      throw new Error("provider update failed after rollback");
    });
    expect(() =>
      synchronizeContextAdapter(driver("codex"), action.challenge, {
        releaseRoot,
        planInstall: () => ({
          ...fixture.plan,
          provider: "codex",
          previous: { ...fixture.previous, provider: "codex" },
        }),
        repairOperation: failedRepair,
      }),
    ).toThrow("provider update failed");
    expect(readContextIntegrationInstallManifest("codex")?.adapterVersion).toBe("0.9.0");

    const retry = vi.fn();
    const result = synchronizeContextAdapter(driver("codex"), action.challenge, {
      releaseRoot,
      planInstall: () => ({ ...fixture.plan, provider: "codex", previous: { ...fixture.previous, provider: "codex" } }),
      repairOperation: retry,
    });
    expect(result).toMatchObject({ updated: true, currentSessionAdoption: "next_session" });
    expect(retry).toHaveBeenCalledOnce();
  });

  it("binds the sync action to the active account while reusing the user-level Plugin install", () => {
    const fixture = prepareOldCompatibleInstall();
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_ffffffff\n");
    const action = issueAdapterSyncAction(
      {
        provider: "claude-code",
        sessionId: "session-new-account",
        suppliedAdapterDigest: fixture.previous.adapterDigest,
      },
      { releaseRoot, driver: driver("claude-code") },
    );
    const repair = vi.fn();

    expect(
      synchronizeContextAdapter(driver("claude-code"), action.challenge, {
        releaseRoot,
        planInstall: () => fixture.plan,
        repairOperation: repair,
      }),
    ).toMatchObject({ updated: true });
    expect(repair).toHaveBeenCalledOnce();
  });

  it("refuses downgrade, account mismatch, and changed exact target without provider mutation", () => {
    const fixture = prepareOldCompatibleInstall();
    const target = fixture.release.manifest.providers["claude-code"];
    writeContextIntegrationInstallManifest({ ...fixture.previous, adapterVersion: "9.0.0" });
    expect(() =>
      issueAdapterSyncAction(
        { provider: "claude-code", sessionId: "session-a", suppliedAdapterDigest: fixture.previous.adapterDigest },
        { releaseRoot, driver: driver("claude-code") },
      ),
    ).toThrow("downgrade");

    writeContextIntegrationInstallManifest(fixture.previous);
    const action = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-a", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_ffffffff\n");
    expect(() => synchronizeContextAdapter(driver("claude-code"), action.challenge, { releaseRoot })).toThrow(
      "changed after",
    );
    writeFileSync(join(home, "config", "client.yaml"), "client:\n  id: client_1234abcd\n");
    const repair = vi.fn();
    expect(() =>
      synchronizeContextAdapter(driver("claude-code"), action.challenge, {
        releaseRoot,
        planInstall: () => ({
          ...fixture.plan,
          release: {
            ...fixture.release,
            manifest: {
              ...fixture.release.manifest,
              providers: {
                ...fixture.release.manifest.providers,
                "claude-code": { ...target, adapterDigest: `sha256:${"f".repeat(64)}` },
              },
            },
          },
        }),
        repairOperation: repair,
      }),
    ).toThrow("exact automatic update plan");
    expect(repair).not.toHaveBeenCalled();
  });

  it("holds the account-state mutation lock across validation, provider repair, and receipt consumption", () => {
    const fixture = prepareOldCompatibleInstall();
    const action = issueAdapterSyncAction(
      { provider: "claude-code", sessionId: "session-lock", suppliedAdapterDigest: fixture.previous.adapterDigest },
      { releaseRoot, driver: driver("claude-code") },
    );
    const repair = vi.fn(() => {
      const lock = join(home, "state", "account-state.lock");
      const result = execFileSync(
        process.execPath,
        [
          "-e",
          "const fs=require('node:fs');try{const fd=fs.openSync(process.argv[1],'wx');fs.closeSync(fd);process.stdout.write('acquired')}catch(e){process.stdout.write(e.code)}",
          lock,
        ],
        { encoding: "utf8" },
      );
      expect(result).toBe("EEXIST");
      writeContextIntegrationInstallManifest({
        ...fixture.previous,
        adapterVersion: fixture.target.adapterVersion,
        adapterDigest: fixture.target.adapterDigest,
      });
    });

    expect(
      synchronizeContextAdapter(driver("claude-code"), action.challenge, {
        releaseRoot,
        planInstall: () => fixture.plan,
        repairOperation: repair,
      }),
    ).toMatchObject({ updated: true });
    expect(repair).toHaveBeenCalledOnce();
  });
});

function prepareOldCompatibleInstall() {
  const release = resolveContextIntegrationRelease(releaseRoot);
  const target = release.manifest.providers["claude-code"];
  const payload = prepareProviderPayload("claude-code");
  const previous = {
    schemaVersion: 1 as const,
    accountClientId: "client_1234abcd",
    channel: "dev" as const,
    provider: "claude-code" as const,
    firstTreeVersion: COMMAND_VERSION,
    bundleVersion: "0.1.0",
    adapterVersion: "0.9.0",
    loaderProtocolVersion: 1 as const,
    bundleDigest: release.manifest.bundleDigest,
    policyDigest: release.manifest.policyDigest,
    adapterDigest: `sha256:${"1".repeat(64)}`,
    marketplaceName: "first-tree-dev",
    pluginName: "first-tree-context",
    materializedInvocation: "first-tree-dev",
    materializedPayloadDigest: payload.pluginDigest,
    materializedMarketplaceDigest: payload.marketplaceDigest,
    installedAt: new Date().toISOString(),
  };
  writeContextIntegrationInstallManifest(previous);
  const codexPayload = prepareProviderPayload("codex");
  writeContextIntegrationInstallManifest({
    ...previous,
    provider: "codex",
    materializedPayloadDigest: codexPayload.pluginDigest,
    materializedMarketplaceDigest: codexPayload.marketplaceDigest,
  });
  return {
    release,
    previous,
    plan: {
      provider: "claude-code" as const,
      operation: "repair" as const,
      previous,
      release,
      probe: {
        provider: "claude-code" as const,
        binaryAvailable: true,
        version: "1.0.0",
        compatible: true,
        installed: true,
        enabled: true,
        installedPath: "/plugin",
        issues: [],
      },
      marketplaceName: "first-tree-dev",
    },
    target,
  };
}

function driver(provider: "claude-code" | "codex"): ContextIntegrationProviderDriver {
  return {
    provider,
    executable: provider === "codex" ? "codex" : "claude",
    minimumVersion: "0.1.0",
    probe: () => ({
      provider,
      binaryAvailable: true,
      version: "1.0.0",
      compatible: true,
      installed: true,
      enabled: true,
      installedPath: join(home, "provider-cache", provider),
      issues: [],
    }),
    inspectHook: async () => ({ trust: "unknown", enabled: null, source: "unavailable", issues: [] }),
    validateMarketplace: () => undefined,
    install: () => {
      throw new Error("not used");
    },
    uninstall: () => undefined,
  };
}

function prepareProviderPayload(provider: "claude-code" | "codex") {
  const marketplace = join(home, "state", "context", "providers", provider, "marketplace");
  const plugin = join(marketplace, "plugins", "first-tree-context");
  const providerCache = join(home, "provider-cache", provider);
  mkdirSync(join(plugin, "bin"), { recursive: true });
  writeFileSync(join(marketplace, "marketplace.json"), "{}\n");
  const launcher = join(plugin, "bin", "context-session-start");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o700);
  cpSync(plugin, providerCache, { recursive: true });
  return {
    pluginDigest: contextPluginTreeDigest(plugin),
    marketplaceDigest: contextPluginTreeDigest(marketplace),
  };
}

function buildRelease(target: string): void {
  const repoRoot = resolve(import.meta.dirname, "../../../..");
  execFileSync(process.execPath, [
    join(repoRoot, "scripts", "build-context-integration-bundle.mjs"),
    "--out-dir",
    target,
    "--version",
    COMMAND_VERSION,
    "--channel",
    "dev",
  ]);
}
