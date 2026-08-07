import { join } from "node:path";
import type { ContextIntegrationInstallManifest, ContextIntegrationProvider } from "@first-tree/shared";
import semver from "semver";
import { channelConfig } from "../channel.js";
import { contextIntegrationMarketplaceName, contextIntegrationMarketplaceSourcePath } from "./installer.js";
import { readContextIntegrationInstallManifest } from "./manifest.js";
import { inspectContextPluginPayload } from "./payload-integrity.js";
import type { ContextIntegrationProviderDriver, ProviderPluginProbe } from "./provider-driver.js";
import { type ContextIntegrationRelease, resolveContextIntegrationRelease } from "./release.js";

export type ContextIntegrationRuntimeHealth = {
  provider: ContextIntegrationProvider;
  healthy: boolean;
  issues: string[];
  install: ContextIntegrationInstallManifest | null;
  release: ContextIntegrationRelease | null;
  probe: ProviderPluginProbe;
};

export function inspectContextIntegrationRuntime(
  driver: ContextIntegrationProviderDriver,
  options: { releaseRoot?: string } = {},
): ContextIntegrationRuntimeHealth {
  const issues: string[] = [];
  let release: ContextIntegrationRelease | null = null;
  try {
    release = resolveContextIntegrationRelease(options.releaseRoot);
  } catch (error) {
    issues.push(`Current First Tree Context release is invalid: ${message(error)}`);
  }

  let install: ContextIntegrationInstallManifest | null = null;
  try {
    install = readContextIntegrationInstallManifest(driver.provider);
  } catch (error) {
    issues.push(`Installed Context manifest is invalid: ${message(error)}`);
  }

  const probe = driver.probe(
    install?.marketplaceName ?? contextIntegrationMarketplaceName(),
    install?.pluginName ?? "first-tree-context",
  );
  const minimumVersion = release?.manifest.providers[driver.provider].minimumVersion ?? driver.minimumVersion;
  if (!probe.binaryAvailable) {
    issues.push(`${driver.executable} is unavailable.`);
  } else if (
    !probe.compatible ||
    !probe.version ||
    !semver.valid(probe.version) ||
    semver.lt(probe.version, minimumVersion)
  ) {
    issues.push(`${driver.executable} ${probe.version ?? "unknown"} must be upgraded to ${minimumVersion} or newer.`);
  }
  if (!probe.installed || !probe.enabled) {
    issues.push("The First Tree Context Plugin is not installed and enabled.");
  }
  for (const issue of probe.issues) {
    if (!issues.includes(issue)) issues.push(issue);
  }

  if (!install) {
    issues.push("The First Tree Context install manifest is missing.");
  } else if (release) {
    const expected = release.manifest.providers[driver.provider];
    if (
      install.channel !== channelConfig.channel ||
      install.adapterVersion !== expected.adapterVersion ||
      install.adapterDigest !== expected.adapterDigest ||
      install.loaderProtocolVersion !== 1
    ) {
      issues.push("The installed Context Plugin does not match this First Tree release.");
    }
  }
  if (release) {
    for (const issue of inspectContextPluginPayload(
      probe,
      join(
        contextIntegrationMarketplaceSourcePath(driver.provider),
        "plugins",
        install?.pluginName ?? "first-tree-context",
      ),
      release,
      driver.provider,
      install?.materializedInvocation,
    )) {
      if (!issues.includes(issue)) issues.push(issue);
    }
  }

  return {
    provider: driver.provider,
    healthy: issues.length === 0,
    issues,
    install,
    release,
    probe,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
