import { describe, expect, it, vi } from "vitest";
import {
  type AutoUpgradeDeps,
  type VersionCacheEntry,
  checkAndAutoUpgrade,
} from "../src/products/tree/engine/runtime/auto-upgrade.js";

function makeDeps(overrides: Partial<AutoUpgradeDeps> = {}): {
  deps: AutoUpgradeDeps;
  state: { cache: VersionCacheEntry | null; installs: string[] };
} {
  const state = {
    cache: null as VersionCacheEntry | null,
    installs: [] as string[],
  };
  const deps: AutoUpgradeDeps = {
    currentVersion: "0.2.0",
    fetchLatestVersion: vi.fn(async () => "0.2.0"),
    installLatestVersion: vi.fn((version: string) => {
      state.installs.push(version);
      return true;
    }),
    readCache: () => state.cache,
    writeCache: (entry) => {
      state.cache = entry;
    },
    now: () => 1_000_000,
    ...overrides,
  };
  return { deps, state };
}

describe("checkAndAutoUpgrade", () => {
  it("uses the cached latest version when the cache is fresh", async () => {
    const { deps, state } = makeDeps({
      currentVersion: "0.2.0",
    });
    state.cache = { checkedAt: 1_000_000 - 1000, latest: "0.2.0" };
    const fetchSpy = vi.fn(async () => "0.3.0");
    deps.fetchLatestVersion = fetchSpy;

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("cache-fresh");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.installs).toEqual([]);
  });

  it("upgrades immediately when the cache says a newer version exists", async () => {
    const { deps, state } = makeDeps({
      currentVersion: "0.2.0",
    });
    state.cache = { checkedAt: 1_000_000 - 1000, latest: "0.3.0" };
    const fetchSpy = vi.fn(async () => "0.4.0");
    deps.fetchLatestVersion = fetchSpy;

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("upgraded");
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.installs).toEqual(["0.3.0"]);
  });

  it("hits the registry when the cache is stale and skips when already latest", async () => {
    const { deps, state } = makeDeps({ currentVersion: "0.2.0" });
    state.cache = {
      checkedAt: 1_000_000 - 24 * 60 * 60 * 1000, // 1 day old
      latest: "0.1.0",
    };
    deps.fetchLatestVersion = vi.fn(async () => "0.2.0");

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("already-latest");
    expect(result.attempted).toBe(false);
    expect(state.cache?.latest).toBe("0.2.0");
    expect(state.cache?.checkedAt).toBe(1_000_000);
  });

  it("upgrades after a cache-stale fetch finds a newer version", async () => {
    const { deps, state } = makeDeps({ currentVersion: "0.2.0" });
    deps.fetchLatestVersion = vi.fn(async () => "0.3.1");

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("upgraded");
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(true);
    expect(state.installs).toEqual(["0.3.1"]);
    expect(state.cache?.latest).toBe("0.3.1");
  });

  it("returns fetch-failed and does not write cache when the registry is unreachable", async () => {
    const { deps, state } = makeDeps({ currentVersion: "0.2.0" });
    deps.fetchLatestVersion = vi.fn(async () => null);

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("fetch-failed");
    expect(result.attempted).toBe(false);
    expect(state.cache).toBeNull();
    expect(state.installs).toEqual([]);
  });

  it("returns install-failed when npm install fails after a fresh fetch", async () => {
    const { deps, state } = makeDeps({ currentVersion: "0.2.0" });
    deps.fetchLatestVersion = vi.fn(async () => "0.3.0");
    deps.installLatestVersion = vi.fn(() => false);

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("install-failed");
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(state.cache?.latest).toBe("0.3.0");
  });

  it("returns install-failed when npm install fails after a cached newer version", async () => {
    const { deps, state } = makeDeps({ currentVersion: "0.2.0" });
    state.cache = { checkedAt: 1_000_000 - 1000, latest: "0.3.0" };
    deps.installLatestVersion = vi.fn(() => false);

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("install-failed");
    expect(result.attempted).toBe(true);
    expect(result.succeeded).toBe(false);
  });

  it("treats fetch exceptions as fetch failures", async () => {
    const { deps } = makeDeps({ currentVersion: "0.2.0" });
    deps.fetchLatestVersion = vi.fn(async () => {
      throw new Error("network down");
    });

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("fetch-failed");
  });

  it("does not downgrade when the registry reports an older version", async () => {
    const { deps, state } = makeDeps({ currentVersion: "0.3.0" });
    deps.fetchLatestVersion = vi.fn(async () => "0.2.5");

    const result = await checkAndAutoUpgrade(deps);

    expect(result.reason).toBe("already-latest");
    expect(state.installs).toEqual([]);
  });
});
