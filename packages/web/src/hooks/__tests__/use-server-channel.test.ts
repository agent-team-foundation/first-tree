// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client.js";
import {
  extractAuthProviderAvailability,
  extractChannel,
  extractGrowthLandingPagesEnabled,
  useGrowthLandingPagesEnabled,
  useGrowthLandingPagesState,
  useServerChannelState,
} from "../use-server-channel.js";

vi.mock("../../api/client.js", () => ({
  api: {
    get: vi.fn(),
  },
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true });

type ObservedBootstrap = {
  channel: ReturnType<typeof useServerChannelState>;
  growth: ReturnType<typeof useGrowthLandingPagesState>;
  growthEnabled: boolean;
};

let root: Root | null = null;
let queryClient: QueryClient | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  queryClient?.clear();
  queryClient = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { IS_REACT_ACT_ENVIRONMENT: true });
});

/**
 * Pure-function unit tests for public bootstrap-config probes. The hook wires
 * these into React Query (fetched once, cached for the session); callers cover
 * their own render gates.
 */
describe("extractChannel", () => {
  it("returns each known channel from a well-formed bootstrap config", () => {
    expect(extractChannel({ channel: "dev" })).toBe("dev");
    expect(extractChannel({ channel: "staging" })).toBe("staging");
    expect(extractChannel({ channel: "prod" })).toBe("prod");
  });

  it("returns null for null / non-object input", () => {
    expect(extractChannel(null)).toBeNull();
    expect(extractChannel("staging")).toBeNull();
    expect(extractChannel(42)).toBeNull();
  });

  it("returns null when channel is missing or unrecognised (older server / malformed)", () => {
    expect(extractChannel({})).toBeNull();
    expect(extractChannel({ serverCommandVersion: "1.2.3" })).toBeNull();
    expect(extractChannel({ channel: "qa" })).toBeNull();
    expect(extractChannel({ channel: 1 })).toBeNull();
  });
});

describe("extractGrowthLandingPagesEnabled", () => {
  it("returns true only for an explicit true bootstrap flag", () => {
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: true })).toBe(true);
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: false })).toBe(false);
  });

  it("fails closed for older or malformed bootstrap configs", () => {
    expect(extractGrowthLandingPagesEnabled(null)).toBe(false);
    expect(extractGrowthLandingPagesEnabled({})).toBe(false);
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: "true" })).toBe(false);
    expect(extractGrowthLandingPagesEnabled({ growthLandingPagesEnabled: 1 })).toBe(false);
  });
});

describe("extractAuthProviderAvailability", () => {
  it("accepts the public provider availability shape", () => {
    expect(extractAuthProviderAvailability({ authProviders: { google: true, github: false } })).toEqual({
      google: true,
      github: false,
    });
  });

  it("fails closed for missing or malformed availability", () => {
    expect(extractAuthProviderAvailability({})).toEqual({ google: false, github: false });
    expect(extractAuthProviderAvailability({ authProviders: { google: "yes", github: true } })).toEqual({
      google: false,
      github: false,
    });
  });
});

describe("server bootstrap hooks", () => {
  it("reads channel and growth flags from the public bootstrap config", async () => {
    vi.mocked(api.get).mockResolvedValueOnce({
      channel: "staging",
      growthLandingPagesEnabled: true,
      authProviders: { google: true, github: true },
    });

    const observed = await renderBootstrapProbe();

    expect(api.get).toHaveBeenCalledWith("/bootstrap/config");
    expect(observed.channel).toEqual({ channel: "staging", settled: true });
    expect(observed.growth).toEqual({ enabled: true, settled: true });
    expect(observed.growthEnabled).toBe(true);
  });

  it("settles to safe defaults when the bootstrap config request fails", async () => {
    vi.mocked(api.get).mockRejectedValueOnce(new Error("bootstrap unavailable"));

    const observed = await renderBootstrapProbe();

    expect(observed.channel).toEqual({ channel: null, settled: true });
    expect(observed.growth).toEqual({ enabled: false, settled: true });
    expect(observed.growthEnabled).toBe(false);
  });
});

async function renderBootstrapProbe(): Promise<ObservedBootstrap> {
  const observedRef: { current: ObservedBootstrap | null } = { current: null };

  function Probe(): null {
    observedRef.current = {
      channel: useServerChannelState(),
      growth: useGrowthLandingPagesState(),
      growthEnabled: useGrowthLandingPagesEnabled(),
    };
    return null;
  }

  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  queryClient = client;
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);

  await act(async () => {
    root?.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
  });

  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const observed = observedRef.current;
    if (observed?.channel.settled && observed.growth.settled) return observed;
  }
  throw new Error("server bootstrap probe did not settle");
}
