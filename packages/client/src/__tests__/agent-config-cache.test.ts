import type { AgentRuntimeConfig } from "@first-tree/shared";
import { describe, expect, it, vi } from "vitest";
import { createAgentConfigCache } from "../runtime/agent-config-cache.js";
import type { FirstTreeHubSDK } from "../sdk.js";

function makeConfig(version: number, urls: string[] = []): AgentRuntimeConfig {
  return {
    agentId: "agent-1",
    version,
    payload: {
      kind: "claude-code",
      prompt: { append: "" },
      model: "",
      mcpServers: [],
      env: [],
      gitRepos: urls.map((url) => ({ url })),
    },
    updatedAt: new Date().toISOString(),
    updatedBy: "test",
  };
}

function makeSdkWithConfigs(configs: AgentRuntimeConfig[]): FirstTreeHubSDK {
  let i = 0;
  const fetch = vi.fn(async () => {
    const cfg = configs[i] ?? configs[configs.length - 1];
    i++;
    if (!cfg) throw new Error("no config");
    return cfg;
  });
  return { fetchAgentConfig: fetch, isHubReachable: vi.fn() } as unknown as FirstTreeHubSDK;
}

describe("AgentConfigCache (Step 4)", () => {
  it("refresh fetches once + populates cache", async () => {
    const cfg = makeConfig(3);
    const sdk = makeSdkWithConfigs([cfg]);
    const cache = createAgentConfigCache({ sdk });
    const result = await cache.refresh("agent-1");
    expect(result.version).toBe(3);
    expect(cache.get("agent-1")?.version).toBe(3);
    expect(sdk.fetchAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("refreshIfNewer fetches when incoming > local", async () => {
    const cfg1 = makeConfig(1);
    const cfg2 = makeConfig(5);
    const sdk = makeSdkWithConfigs([cfg1, cfg2]);
    const cache = createAgentConfigCache({ sdk });
    await cache.refresh("agent-1");
    const updated = await cache.refreshIfNewer("agent-1", 5);
    expect(updated.version).toBe(5);
    expect(sdk.fetchAgentConfig).toHaveBeenCalledTimes(2);
  });

  it("refreshIfNewer is no-op when incoming <= local", async () => {
    const cfg = makeConfig(5);
    const sdk = makeSdkWithConfigs([cfg]);
    const cache = createAgentConfigCache({ sdk });
    await cache.refresh("agent-1");
    const noop = await cache.refreshIfNewer("agent-1", 3);
    expect(noop.version).toBe(5);
    expect(sdk.fetchAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("concurrent refreshIfNewer collapses to a single fetch (per-agent inflight queue)", async () => {
    const cfg = makeConfig(2);
    const sdk = makeSdkWithConfigs([cfg]);
    const cache = createAgentConfigCache({ sdk });
    const [a, b, c] = await Promise.all([
      cache.refreshIfNewer("agent-1", 2),
      cache.refreshIfNewer("agent-1", 2),
      cache.refreshIfNewer("agent-1", 2),
    ]);
    expect(a.version).toBe(2);
    expect(b.version).toBe(2);
    expect(c.version).toBe(2);
    expect(sdk.fetchAgentConfig).toHaveBeenCalledTimes(1);
  });

  it("allReferencedUrls aggregates across agents", async () => {
    const cfgA = makeConfig(1, ["https://github.com/foo/a.git"]);
    const cfgB = makeConfig(1, ["https://github.com/foo/b.git", "https://github.com/foo/c.git"]);
    const sdkA = makeSdkWithConfigs([cfgA]);
    const cacheA = createAgentConfigCache({ sdk: sdkA });
    const sdkB = makeSdkWithConfigs([{ ...cfgB, agentId: "agent-2" }]);
    const cacheB = createAgentConfigCache({ sdk: sdkB });
    await cacheA.refresh("agent-1");
    await cacheB.refresh("agent-2");
    expect([...cacheA.allReferencedUrls()]).toEqual(["https://github.com/foo/a.git"]);
    expect([...cacheB.allReferencedUrls()].sort()).toEqual([
      "https://github.com/foo/b.git",
      "https://github.com/foo/c.git",
    ]);
  });

  it("forget drops everything for an agent", async () => {
    const cfg = makeConfig(1, ["https://github.com/foo/a.git"]);
    const sdk = makeSdkWithConfigs([cfg]);
    const cache = createAgentConfigCache({ sdk });
    await cache.refresh("agent-1");
    cache.forget("agent-1");
    expect(cache.get("agent-1")).toBeUndefined();
    expect(cache.allReferencedUrls().size).toBe(0);
  });

  it("rejected fetch is propagated and not cached as inflight forever", async () => {
    const sdk = {
      fetchAgentConfig: vi.fn().mockRejectedValueOnce(new Error("Hub down")).mockResolvedValueOnce(makeConfig(1)),
      isHubReachable: vi.fn(),
    } as unknown as FirstTreeHubSDK;
    const cache = createAgentConfigCache({ sdk });
    await expect(cache.refresh("agent-1")).rejects.toThrow(/Hub down/);
    // Second call should retry, not return the failed inflight.
    const ok = await cache.refresh("agent-1");
    expect(ok.version).toBe(1);
    expect(sdk.fetchAgentConfig).toHaveBeenCalledTimes(2);
  });
});
