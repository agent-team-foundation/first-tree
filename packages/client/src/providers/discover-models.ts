import type { ProviderModelCatalog, RuntimeProvider } from "@first-tree/shared";
import {
  discoverCursorModels,
  discoverKimiModels,
  type HostDiscoverModelsDeps,
  parseCursorModelsOutput,
  parseKimiConfigModels,
  resolveKimiConfigPath,
  unavailableCatalog,
} from "../runtime/capabilities/discover-models.js";
import { discoverGrokModels, type GrokDiscoverModelsDeps } from "./grok/discover-models.js";

/**
 * Composition-owned model discovery deps. Host (Cursor/Kimi) helpers remain
 * transitional under Runtime capabilities; Grok discovery lives in the Grok
 * family. This module is the only place that wires concrete provider discovery
 * into a single dispatcher — Runtime must not reverse-import Grok.
 */
export type DiscoverModelsDeps = HostDiscoverModelsDeps & GrokDiscoverModelsDeps;

export type { GrokDiscoverModelsDeps, HostDiscoverModelsDeps };
export { parseCursorModelsOutput, parseKimiConfigModels, resolveKimiConfigPath };

/**
 * Discover the model catalog for a runtime provider from the host-local
 * provider. Phase 1 implements Cursor + Kimi + Grok; other providers return
 * `source: "unavailable"` so the web can keep its curated/fallback UI.
 */
export async function discoverProviderModels(
  provider: RuntimeProvider,
  deps: DiscoverModelsDeps = {},
): Promise<ProviderModelCatalog> {
  switch (provider) {
    case "cursor":
      return discoverCursorModels(deps);
    case "grok":
      return discoverGrokModels(deps);
    case "kimi-code":
      return discoverKimiModels(deps);
    case "opencode":
      return unavailableCatalog(
        provider,
        "OpenCode model discovery is not enabled in V1; enter the provider-native provider/model id",
        deps,
      );
    case "pi":
      return unavailableCatalog(
        provider,
        "Pi model discovery is not enabled in V1; enter the provider-native provider/model id",
        deps,
      );
    case "claude-code":
    case "claude-code-tui":
    case "codex":
      return unavailableCatalog(provider, `Host-local model discovery for ${provider} lands in a later phase`, deps);
    default: {
      const _exhaustive: never = provider;
      return unavailableCatalog(_exhaustive, `Unknown provider: ${String(provider)}`, deps);
    }
  }
}
