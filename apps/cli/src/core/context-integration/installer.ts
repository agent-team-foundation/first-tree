import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type ContextIntegrationInstallJournal,
  type ContextIntegrationInstallManifest,
  type ContextIntegrationProvider,
  contextIntegrationInstallJournalSchema,
} from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import semver from "semver";
import { channelConfig } from "../channel.js";
import { COMMAND_VERSION } from "../version.js";
import { readActiveContextAccountClientId } from "./account-state-guard.js";
import {
  beginContextAdapterNextSessionObligation,
  type ContextAdapterNextSessionObligationKind,
  clearContextAdapterObservation,
} from "./adapter-observation.js";
import { withContextIntegrationLock } from "./context-binding-store.js";
import {
  readContextIntegrationInstallManifest,
  removeContextIntegrationInstallManifest,
  writeContextIntegrationInstallManifest,
} from "./manifest.js";
import {
  contextPluginTreeDigest,
  inspectContextPluginPayload,
  materializeContextPluginPayload,
  verifyMaterializedContextPlugin,
  verifyProviderInstalledContextPlugin,
} from "./payload-integrity.js";
import type { ContextIntegrationProviderDriver, ProviderPluginProbe } from "./provider-driver.js";
import {
  type ContextIntegrationRelease,
  resolveContextIntegrationRelease,
  verifyContextIntegrationRelease,
} from "./release.js";

const PLUGIN_NAME = "first-tree-context";

export type ContextIntegrationInstallPlan = {
  provider: ContextIntegrationProvider;
  operation: "install" | "repair" | "unchanged";
  previous: ContextIntegrationInstallManifest | null;
  release: ContextIntegrationRelease;
  probe: ProviderPluginProbe;
  marketplaceName: string;
};

export function planContextIntegrationInstall(
  driver: ContextIntegrationProviderDriver,
  options: { releaseRoot?: string } = {},
): ContextIntegrationInstallPlan {
  assertCompatibleIncompleteInstall(driver.provider);
  const release = resolveContextIntegrationRelease(options.releaseRoot);
  const marketplaceName = contextIntegrationMarketplaceName();
  const previous = readContextIntegrationInstallManifest(driver.provider);
  const probe = driver.probe(marketplaceName, PLUGIN_NAME);
  assertProviderCompatible(driver, probe, release.manifest.providers[driver.provider].minimumVersion);
  const expected = release.manifest.providers[driver.provider];
  const manifestMatches =
    previous?.adapterVersion === expected.adapterVersion &&
    previous.adapterDigest === expected.adapterDigest &&
    previous.loaderProtocolVersion === 1 &&
    previous.channel === channelConfig.channel;
  const payloadIssues = inspectContextPluginPayload(
    probe,
    join(contextIntegrationMarketplaceSourcePath(driver.provider), "plugins", PLUGIN_NAME),
    release,
    driver.provider,
    previous?.materializedInvocation,
  );
  const incomplete = readContextIntegrationInstallJournal();
  const operation =
    !incomplete && manifestMatches && payloadIssues.length === 0 && probe.installed && probe.enabled
      ? "unchanged"
      : previous || probe.installed
        ? "repair"
        : "install";
  return {
    provider: driver.provider,
    operation,
    previous,
    release,
    probe,
    marketplaceName,
  };
}

export function installContextIntegration(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  options: { nextSessionObligationKind?: ContextAdapterNextSessionObligationKind } = {},
): {
  manifest: ContextIntegrationInstallManifest;
  probe: ProviderPluginProbe;
} {
  return withContextIntegrationLock(() => installContextIntegrationLocked(driver, plan, options));
}

function installContextIntegrationLocked(
  driver: ContextIntegrationProviderDriver,
  plan: ContextIntegrationInstallPlan,
  options: { nextSessionObligationKind?: ContextAdapterNextSessionObligationKind },
): {
  manifest: ContextIntegrationInstallManifest;
  probe: ProviderPluginProbe;
} {
  if (driver.provider !== plan.provider) {
    throw new Error("Context integration install plan does not match the provider driver.");
  }
  assertCompatibleIncompleteInstall(driver.provider);
  verifyContextIntegrationRelease(plan.release);
  const currentManifest = readContextIntegrationInstallManifest(driver.provider);
  if (!sameInstallManifest(currentManifest, plan.previous)) {
    throw new Error("The Context Plugin install state changed after the displayed plan. Run the command again.");
  }
  const currentProbe = driver.probe(plan.marketplaceName, PLUGIN_NAME);
  if (!sameProviderProbe(currentProbe, plan.probe)) {
    throw new Error("The provider Plugin state changed after the displayed plan. Run the command again.");
  }
  assertProviderCompatible(driver, currentProbe, plan.release.manifest.providers[driver.provider].minimumVersion);
  const journal = {
    schemaVersion: 1 as const,
    provider: driver.provider,
    operation: plan.operation,
    previousBundleDigest: plan.previous?.bundleDigest ?? null,
    targetBundleDigest: plan.release.manifest.bundleDigest,
    startedAt: new Date().toISOString(),
  };
  writeInstallJournal({ ...journal, phase: "prepared" });
  const stagingParent = join(defaultHome(), "state", "context", "staging");
  mkdirSync(stagingParent, { recursive: true, mode: 0o700 });
  const stagingRoot = mkdtempSync(join(stagingParent, `${driver.provider}-`));
  const stagedMarketplaceRoot = join(stagingRoot, "marketplace");
  const stableMarketplaceRoot = contextIntegrationMarketplaceSourcePath(driver.provider);
  const previousMarketplaceSource = join(stagingRoot, "previous-marketplace-source");
  let rollbackMarketplaceRoot: string | null = null;
  let providerMutationStarted = false;
  let marketplaceSourcePromoted = false;
  let rollbackNextSessionObligation: (() => void) | null = null;
  const providerReleaseRoot = join(plan.release.root, driver.provider);
  try {
    if (driver.provider === "claude-code" && options.nextSessionObligationKind) {
      rollbackNextSessionObligation = beginContextAdapterNextSessionObligation(
        plan.release.manifest,
        options.nextSessionObligationKind,
      );
    }
    rollbackMarketplaceRoot =
      plan.previous && plan.probe.installed ? prepareRollbackMarketplace(stagingRoot, driver.provider, plan) : null;
    cpSync(providerReleaseRoot, stagedMarketplaceRoot, { recursive: true });
    const materializedInvocation = materializeContextPluginPayload(
      join(stagedMarketplaceRoot, "plugins", PLUGIN_NAME),
      plan.release.manifest.providers[driver.provider].adapterDigest,
    );
    driver.validateMarketplace(stagedMarketplaceRoot);
    promoteMarketplaceSource(stagedMarketplaceRoot, stableMarketplaceRoot, previousMarketplaceSource);
    marketplaceSourcePromoted = true;
    writeInstallJournal({ ...journal, phase: "provider_installing" });
    providerMutationStarted = true;
    const probe = driver.install({
      marketplaceRoot: stableMarketplaceRoot,
      marketplaceName: plan.marketplaceName,
      pluginName: PLUGIN_NAME,
    });
    const installedPayloadDigest = verifyMaterializedContextPlugin(
      join(stableMarketplaceRoot, "plugins", PLUGIN_NAME),
      plan.release,
      driver.provider,
      materializedInvocation,
    );
    verifyProviderInstalledContextPlugin(probe, installedPayloadDigest);
    writeInstallJournal({ ...journal, phase: "provider_installed" });
    const manifest: ContextIntegrationInstallManifest = {
      schemaVersion: 1,
      accountClientId: readActiveContextAccountClientId(),
      channel: channelConfig.channel,
      provider: driver.provider,
      firstTreeVersion: COMMAND_VERSION,
      bundleVersion: plan.release.manifest.version,
      adapterVersion: plan.release.manifest.providers[driver.provider].adapterVersion,
      loaderProtocolVersion: 1,
      bundleDigest: plan.release.manifest.bundleDigest,
      policyDigest: plan.release.manifest.policyDigest,
      adapterDigest: plan.release.manifest.providers[driver.provider].adapterDigest,
      marketplaceName: plan.marketplaceName,
      pluginName: PLUGIN_NAME,
      materializedInvocation,
      materializedPayloadDigest: installedPayloadDigest,
      materializedMarketplaceDigest: contextPluginTreeDigest(stableMarketplaceRoot),
      installedAt: new Date().toISOString(),
    };
    writeContextIntegrationInstallManifest(manifest);
    clearContextAdapterObservation(driver.provider, {
      includeNextSessionRequired: driver.provider === "claude-code" && !options.nextSessionObligationKind,
    });
    removeInstallJournal();
    return { manifest, probe };
  } catch (error) {
    if (!providerMutationStarted) {
      if (marketplaceSourcePromoted) {
        restorePreviousMarketplaceSource(stableMarketplaceRoot, previousMarketplaceSource);
      }
      removeInstallJournal();
    } else if (rollbackMarketplaceRoot && plan.previous) {
      try {
        replaceMarketplaceSource(stableMarketplaceRoot, rollbackMarketplaceRoot);
        const rollbackProbe = driver.install({
          marketplaceRoot: stableMarketplaceRoot,
          marketplaceName: plan.previous.marketplaceName,
          pluginName: plan.previous.pluginName,
        });
        verifyProviderInstalledContextPlugin(
          rollbackProbe,
          contextPluginTreeDigest(join(stableMarketplaceRoot, "plugins", PLUGIN_NAME)),
        );
        removeInstallJournal();
      } catch (rollbackError) {
        writeInstallJournal({ ...journal, phase: "rollback_failed" });
        throw new AggregateError(
          [error, rollbackError],
          `Context Plugin update failed and the previous provider cache could not be restored. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\`.`,
        );
      }
    } else if (plan.previous === null) {
      try {
        driver.uninstall({
          marketplaceName: plan.marketplaceName,
          pluginName: PLUGIN_NAME,
        });
        rmSync(stableMarketplaceRoot, { recursive: true, force: true });
        removeContextIntegrationInstallManifest(driver.provider);
        removeInstallJournal();
      } catch (cleanupError) {
        writeInstallJournal({ ...journal, phase: "rollback_failed" });
        throw new AggregateError(
          [error, cleanupError],
          `Context Plugin install failed and its partial provider state could not be removed. Run \`${channelConfig.binName} context repair --provider ${driver.provider}\`.`,
        );
      }
    }
    rollbackNextSessionObligation?.();
    throw error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function prepareRollbackMarketplace(
  stagingRoot: string,
  provider: ContextIntegrationProvider,
  plan: ContextIntegrationInstallPlan,
): string {
  const installedPath = plan.probe.installedPath;
  if (!installedPath) {
    throw new Error(
      "The provider did not expose the installed First Tree Plugin path, so a safe update rollback cannot be prepared.",
    );
  }
  const root = join(stagingRoot, "rollback-marketplace");
  const pluginRoot = join(root, "plugins", PLUGIN_NAME);
  cpSync(installedPath, pluginRoot, { recursive: true });
  if (provider === "claude-code") {
    writeJson(join(root, ".claude-plugin", "marketplace.json"), {
      name: plan.marketplaceName,
      owner: { name: "First Tree" },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: "./plugins/first-tree-context",
          version: plan.previous?.adapterVersion ?? plan.previous?.bundleVersion,
        },
      ],
    });
  } else {
    writeJson(join(root, ".agents", "plugins", "marketplace.json"), {
      name: plan.marketplaceName,
      interface: { displayName: "First Tree" },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: { source: "local", path: "./plugins/first-tree-context" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Developer Tools",
          interface: { displayName: "First Tree Context" },
        },
      ],
    });
  }
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function uninstallContextIntegration(driver: ContextIntegrationProviderDriver): void {
  withContextIntegrationLock(() => uninstallContextIntegrationLocked(driver));
}

function uninstallContextIntegrationLocked(driver: ContextIntegrationProviderDriver): void {
  assertCompatibleIncompleteInstall(driver.provider);
  const manifest = readContextIntegrationInstallManifest(driver.provider);
  const marketplaceName = manifest?.marketplaceName ?? contextIntegrationMarketplaceName();
  const pluginName = manifest?.pluginName ?? PLUGIN_NAME;
  const journal = {
    schemaVersion: 1 as const,
    provider: driver.provider,
    operation: "uninstall" as const,
    previousBundleDigest: manifest?.bundleDigest ?? null,
    targetBundleDigest: null,
    startedAt: new Date().toISOString(),
    phase: "provider_uninstalling" as const,
  };
  writeInstallJournal(journal);
  try {
    driver.uninstall({
      marketplaceName,
      pluginName,
    });
    rmSync(contextIntegrationMarketplaceSourcePath(driver.provider), { recursive: true, force: true });
    if (manifest) removeContextIntegrationInstallManifest(driver.provider);
    clearContextAdapterObservation(driver.provider, {
      includeNextSessionRequired: true,
      includeCompatibleSessions: true,
    });
    removeInstallJournal();
  } catch (error) {
    writeInstallJournal({ ...journal, phase: "uninstall_failed" });
    throw error;
  }
}

export function contextIntegrationMarketplaceName(): string {
  return channelConfig.channel === "prod" ? "first-tree" : `first-tree-${channelConfig.channel}`;
}

export function contextIntegrationMarketplaceSourcePath(provider: ContextIntegrationProvider): string {
  return join(defaultHome(), "state", "context", "providers", provider, "marketplace");
}

function installJournalPath(): string {
  return join(defaultHome(), "state", "context", "install-journal.json");
}

export function readContextIntegrationInstallJournal(): ContextIntegrationInstallJournal | null {
  try {
    return contextIntegrationInstallJournalSchema.parse(JSON.parse(readFileSync(installJournalPath(), "utf8")));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && Reflect.get(error, "code") === "ENOENT") {
      return null;
    }
    throw new Error(`Invalid Context integration install journal at ${installJournalPath()}.`, { cause: error });
  }
}

function assertCompatibleIncompleteInstall(provider: ContextIntegrationProvider): void {
  const incomplete = readContextIntegrationInstallJournal();
  if (incomplete && incomplete.provider !== provider) {
    throw new Error(
      `A ${incomplete.provider} Context Plugin operation is incomplete. Run \`${channelConfig.binName} context repair --provider ${incomplete.provider}\` before changing ${provider}.`,
    );
  }
}

function writeInstallJournal(journal: ContextIntegrationInstallJournal): void {
  const path = installJournalPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeInstallJournal(): void {
  rmSync(installJournalPath(), { force: true });
}

export function clearContextIntegrationInstallJournal(): void {
  removeInstallJournal();
}

function promoteMarketplaceSource(candidate: string, stable: string, previous: string): void {
  mkdirSync(dirname(stable), { recursive: true, mode: 0o700 });
  if (existsSync(stable)) renameSync(stable, previous);
  try {
    renameSync(candidate, stable);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, stable);
    throw error;
  }
}

function restorePreviousMarketplaceSource(stable: string, previous: string): void {
  rmSync(stable, { recursive: true, force: true });
  if (existsSync(previous)) renameSync(previous, stable);
}

function replaceMarketplaceSource(stable: string, replacement: string): void {
  rmSync(stable, { recursive: true, force: true });
  renameSync(replacement, stable);
}

function sameInstallManifest(
  left: ContextIntegrationInstallManifest | null,
  right: ContextIntegrationInstallManifest | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameProviderProbe(left: ProviderPluginProbe, right: ProviderPluginProbe): boolean {
  return (
    left.provider === right.provider &&
    left.binaryAvailable === right.binaryAvailable &&
    left.version === right.version &&
    left.compatible === right.compatible &&
    left.installed === right.installed &&
    left.enabled === right.enabled &&
    left.installedPath === right.installedPath
  );
}

function assertProviderCompatible(
  driver: ContextIntegrationProviderDriver,
  probe: ProviderPluginProbe,
  releaseMinimumVersion: string,
): void {
  if (!probe.binaryAvailable) {
    throw new Error(`${driver.executable} is unavailable. Install it before enabling First Tree Context.`);
  }
  if (
    !probe.compatible ||
    !probe.version ||
    !semver.valid(probe.version) ||
    semver.lt(probe.version, releaseMinimumVersion)
  ) {
    throw new Error(
      `${driver.executable} ${probe.version ?? "unknown"} is unsupported. Upgrade to ${releaseMinimumVersion} or newer before enabling First Tree Context.`,
    );
  }
  const inspectionIssue = probe.issues.find((issue) => issue.includes("Plugin state could not be inspected"));
  if (inspectionIssue) {
    throw new Error(`${inspectionIssue} No provider mutation was attempted.`);
  }
  if (probe.installed && !probe.enabled) {
    throw new Error(
      `The ${driver.provider} Context Plugin is installed but disabled. Enable it with the provider's native Plugin controls before repair or another First Tree Context mutation; no provider state was changed.`,
    );
  }
}
