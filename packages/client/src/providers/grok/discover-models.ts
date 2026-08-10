import type { ProviderModelCatalog } from "@first-tree/shared";
import { fetchGrokAcpInitializeMeta } from "./acp-session.js";
import { type GrokRuntimeBinaryResolution, resolveGrokRuntimeBinary } from "./binary.js";
import { parseGrokModelState } from "./events.js";

/** Ceiling for the initialize-only ACP handshake behind grok model discovery. */
const GROK_MODELS_TIMEOUT_MS = 20_000;

export type GrokDiscoverModelsDeps = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /**
   * Launch-verified grok resolution (supported version range gate). Discovery
   * spawns the binary, so it must go through `resolveGrokRuntimeBinary`
   * semantics — never the existence-only probe path.
   */
  resolveGrokBinary?: (env: NodeJS.ProcessEnv) => GrokRuntimeBinaryResolution;
  fetchGrokModelMeta?: (
    binary: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ ok: true; meta: Record<string, unknown> | null } | { ok: false; error: string }>;
};

function fetchedAt(deps: GrokDiscoverModelsDeps): string {
  return (deps.now ?? (() => new Date()))().toISOString();
}

function unavailable(error: string, deps: GrokDiscoverModelsDeps): ProviderModelCatalog {
  return {
    provider: "grok",
    models: [],
    defaultModelId: null,
    fetchedAt: fetchedAt(deps),
    source: "unavailable",
    error,
  };
}

/**
 * Grok model discovery: resolve the binary through the SAME launch-verified
 * resolution the handler uses (`resolveGrokRuntimeBinary` — the capability
 * probe stays install-only, but discovery actually spawns, so the supported
 * version range must gate it and probe/discovery/handler agree on the same
 * binary), then run ONLY the `initialize` handshake (empty
 * clientCapabilities, unauthenticated metadata — never touches credentials)
 * and parse `_meta.modelState` from the response. The catalog marks the
 * provider's current model as the default.
 */
export async function discoverGrokModels(deps: GrokDiscoverModelsDeps = {}): Promise<ProviderModelCatalog> {
  const env = deps.env ?? process.env;
  const resolveBinary = deps.resolveGrokBinary ?? ((processEnv) => resolveGrokRuntimeBinary(processEnv));
  const resolution = resolveBinary(env);
  if (!resolution.ok) {
    return unavailable(resolution.error.slice(0, 500), deps);
  }
  const fetchMeta =
    deps.fetchGrokModelMeta ??
    ((bin, processEnv) =>
      fetchGrokAcpInitializeMeta({
        binary: bin,
        env: processEnv,
        timeoutMs: GROK_MODELS_TIMEOUT_MS,
        clientVersion: "0",
      }));
  const result = await fetchMeta(resolution.binary, env);
  if (!result.ok) {
    return unavailable(result.error.slice(0, 500), deps);
  }
  const parsed = parseGrokModelState({ _meta: result.meta });
  if (parsed.models.length === 0) {
    return unavailable("grok initialize response carried no model state", deps);
  }
  return {
    provider: "grok",
    models: parsed.models,
    defaultModelId: parsed.defaultModelId,
    fetchedAt: fetchedAt(deps),
    source: "provider-cli",
    error: null,
  };
}
