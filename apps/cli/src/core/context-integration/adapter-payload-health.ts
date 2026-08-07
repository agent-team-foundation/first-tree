import { join } from "node:path";
import type { ContextIntegrationInstallManifest } from "@first-tree/shared";
import { defaultHome } from "@first-tree/shared/config";
import { readContextIntegrationInstallManifest } from "./manifest.js";
import { contextPluginTreeDigest, verifyProviderInstalledContextPlugin } from "./payload-integrity.js";
import type { ContextIntegrationProviderDriver } from "./provider-driver.js";

/** Revalidates both First Tree's stable marketplace and the provider cache. */
export function assertContextAdapterPayloadHealthy(
  driver: ContextIntegrationProviderDriver,
  expected: { adapterVersion: string; adapterDigest: string },
): ContextIntegrationInstallManifest {
  const install = readContextIntegrationInstallManifest(driver.provider);
  if (
    !install ||
    install.adapterVersion !== expected.adapterVersion ||
    install.adapterDigest !== expected.adapterDigest ||
    !install.materializedPayloadDigest ||
    !install.materializedMarketplaceDigest
  ) {
    throw new Error("The installed Context adapter identity or payload receipt is missing or inconsistent.");
  }
  const stableMarketplace = join(defaultHome(), "state", "context", "providers", driver.provider, "marketplace");
  const stablePlugin = join(stableMarketplace, "plugins", install.pluginName);
  if (contextPluginTreeDigest(stableMarketplace) !== install.materializedMarketplaceDigest) {
    throw new Error("The stable Context adapter marketplace payload has drifted.");
  }
  if (contextPluginTreeDigest(stablePlugin) !== install.materializedPayloadDigest) {
    throw new Error("The stable Context Plugin payload has drifted.");
  }
  const probe = driver.probe(install.marketplaceName, install.pluginName);
  if (!probe.installed || !probe.enabled) {
    throw new Error("The provider-owned Context Plugin is not installed and enabled.");
  }
  verifyProviderInstalledContextPlugin(probe, install.materializedPayloadDigest);
  return install;
}
