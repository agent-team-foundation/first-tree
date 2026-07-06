import type { AgentRuntimeConfig } from "@first-tree/shared";
import type { pino } from "../observability/logger.js";
import type { FirstTreeHubSDK } from "../sdk.js";

/**
 * In-memory cache of per-agent runtime configs (Step 4).
 *
 * The server is the single source of truth (PRD §D11). The cache exists only
 * to skip a fetch when the message-borne `configVersion` matches what we
 * already hold. Whenever the incoming version is newer, we fetch and replace.
 *
 * The prefix `agent-` distinguishes this from `runtime/config.ts` (the local
 * `agent.yaml` parser) — they are unrelated concepts.
 */
export type AgentConfigCacheLogger = pino.Logger;

export interface AgentConfigCache {
  /** Snapshot of the currently cached config, if any. */
  get(agentId: string): AgentRuntimeConfig | undefined;
  /** Swap the SDK transport after a WebSocket rebind mints a new runtime-session token. */
  updateSdk(sdk: FirstTreeHubSDK): void;
  /**
   * Refresh from the server if `incomingVersion > local`; no-op otherwise.
   * Returns the in-cache value after the operation.
   */
  refreshIfNewer(agentId: string, incomingVersion: number): Promise<AgentRuntimeConfig>;
  /** Force a fetch (used at bind time + by §11 acceptance tests). */
  refresh(agentId: string): Promise<AgentRuntimeConfig>;
  /** Update the URL set used by Step 7's mirror gc. */
  updateUrls(agentId: string, urls: string[]): void;
  /** All git URLs currently referenced across all cached agents. */
  allReferencedUrls(): Set<string>;
  /** Drop everything tied to an agent (unbind / delete). */
  forget(agentId: string): void;
}

type CachedEntry = {
  config: AgentRuntimeConfig;
  urls: Set<string>;
  /** Per-agent fetch queue — guarantees we never have two concurrent fetches in flight. */
  inflight: Promise<AgentRuntimeConfig> | null;
};

export type AgentConfigCacheOptions = {
  sdk: FirstTreeHubSDK;
  log?: AgentConfigCacheLogger;
};

export function createAgentConfigCache(opts: AgentConfigCacheOptions): AgentConfigCache {
  let sdk = opts.sdk;
  let sdkGeneration = 0;
  const log = opts.log;
  const entries = new Map<string, CachedEntry>();

  function urlsFromConfig(cfg: AgentRuntimeConfig): Set<string> {
    return new Set(cfg.payload.gitRepos.map((r) => r.url));
  }

  async function doFetch(agentId: string, generation: number): Promise<AgentRuntimeConfig> {
    const fetchSdk = sdk;
    const fetched = await fetchSdk.fetchAgentConfig();
    if (fetched.agentId !== agentId) {
      // Defensive: SDK token always maps to one agent, but this guards against
      // future multi-agent SDKs sharing a cache.
      throw new Error(`AgentConfigCache: fetched config for "${fetched.agentId}" but expected "${agentId}"`);
    }
    if (generation !== sdkGeneration) return fetched;
    const entry: CachedEntry = entries.get(agentId) ?? { config: fetched, urls: new Set(), inflight: null };
    entry.config = fetched;
    entry.urls = urlsFromConfig(fetched);
    entry.inflight = null;
    entries.set(agentId, entry);
    return fetched;
  }

  function refresh(agentId: string): Promise<AgentRuntimeConfig> {
    const existing = entries.get(agentId);
    if (existing?.inflight) return existing.inflight;
    const slot: CachedEntry = existing ?? {
      config: {
        agentId,
        version: 0,
        payload: {
          kind: "claude-code",
          prompt: { append: "" },
          model: "",
          mcpServers: [],
          env: [],
          gitRepos: [],
          resourceSkills: [],
          reasoningEffort: "",
        },
        updatedAt: "",
        updatedBy: "",
      },
      urls: new Set(),
      inflight: null,
    };
    const generation = sdkGeneration;
    let inflight!: Promise<AgentRuntimeConfig>;
    inflight = doFetch(agentId, generation).catch((err) => {
      if (slot.inflight === inflight) {
        slot.inflight = null;
      }
      if (generation !== sdkGeneration) {
        log?.warn({ agentId, err }, "agent config fetch failed after SDK replacement; retrying with latest transport");
        return refresh(agentId);
      }
      log?.warn({ agentId, err }, "agent config fetch failed");
      throw err;
    });
    slot.inflight = inflight;
    entries.set(agentId, slot);
    return inflight;
  }

  return {
    get(agentId) {
      return entries.get(agentId)?.config;
    },

    updateSdk(nextSdk) {
      sdk = nextSdk;
      sdkGeneration++;
      for (const entry of entries.values()) {
        entry.inflight = null;
      }
    },

    refresh,

    async refreshIfNewer(agentId, incomingVersion) {
      const existing = entries.get(agentId);
      if (existing && existing.config.version >= incomingVersion) {
        return existing.config;
      }
      return this.refresh(agentId);
    },

    updateUrls(agentId, urls) {
      const entry = entries.get(agentId);
      if (!entry) return;
      entry.urls = new Set(urls);
    },

    allReferencedUrls() {
      const out = new Set<string>();
      for (const e of entries.values()) {
        for (const u of e.urls) out.add(u);
      }
      return out;
    },

    forget(agentId) {
      entries.delete(agentId);
    },
  };
}
