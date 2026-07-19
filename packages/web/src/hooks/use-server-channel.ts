import { type AuthProviderAvailability, authProviderAvailabilitySchema } from "@first-tree/shared";
import type { ChannelName } from "@first-tree/shared/channel";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";

type ServerBootstrapConfig = {
  channel: ChannelName | null;
  growthLandingPagesEnabled: boolean;
  authProviders: AuthProviderAvailability;
};

/**
 * Narrow the bootstrap `/config` payload to its release channel without an
 * `as` cast. Returns null for any unrecognised shape (older server that does
 * not report `channel`, malformed body) so callers fall back to their safe
 * default — treat unknown as prod and keep channel-scoped UI hidden.
 */
export function extractChannel(data: unknown): ChannelName | null {
  if (typeof data === "object" && data !== null && "channel" in data) {
    const { channel } = data;
    if (channel === "dev" || channel === "staging" || channel === "prod") return channel;
  }
  return null;
}

/**
 * Narrow the growth landing feature flag from the public bootstrap config.
 * Older servers and malformed payloads resolve to false so public growth
 * funnels fail closed.
 */
export function extractGrowthLandingPagesEnabled(data: unknown): boolean {
  if (typeof data === "object" && data !== null && "growthLandingPagesEnabled" in data) {
    const { growthLandingPagesEnabled } = data;
    return growthLandingPagesEnabled === true;
  }
  return false;
}

export function extractAuthProviderAvailability(data: unknown): AuthProviderAvailability {
  if (typeof data !== "object" || data === null || !("authProviders" in data)) {
    return { google: false, github: false };
  }
  const result = authProviderAvailabilitySchema.safeParse(data.authProviders);
  return result.success ? result.data : { google: false, github: false };
}

function extractServerBootstrapConfig(data: unknown): ServerBootstrapConfig {
  return {
    channel: extractChannel(data),
    growthLandingPagesEnabled: extractGrowthLandingPagesEnabled(data),
    authProviders: extractAuthProviderAvailability(data),
  };
}

async function fetchServerBootstrapConfig(): Promise<ServerBootstrapConfig> {
  const data = await api.get<unknown>("/bootstrap/config");
  return extractServerBootstrapConfig(data);
}

function useServerBootstrapConfig(): { config: ServerBootstrapConfig | null; settled: boolean } {
  const { data, status } = useQuery({
    queryKey: ["server-bootstrap-config"],
    queryFn: fetchServerBootstrapConfig,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  // With infinite staleTime `pending` is the only not-yet-resolved status;
  // `success` (a config object) and `error` both count as settled, so safe
  // defaults apply the moment we know.
  return { config: data ?? null, settled: status !== "pending" };
}

/**
 * The release channel this server speaks (`dev` | `staging` | `prod`) plus
 * whether the fetch has settled. A caller that *gates* on the channel
 * (redirects rather than just hides) needs to tell "still loading" (channel is
 * null because the fetch is in flight — render neutral, take no action) apart
 * from "resolved to unknown/prod" (null because the server reported nothing
 * usable — apply the prod-safe default). Server-wide and fixed for the life of
 * a deploy, so it is fetched once from the public bootstrap `/config` endpoint
 * and cached for the session.
 */
export function useServerChannelState(): { channel: ChannelName | null; settled: boolean } {
  const { config, settled } = useServerBootstrapConfig();
  return { channel: config?.channel ?? null, settled };
}

/**
 * Whether growth landing pages are explicitly enabled by the server. This is
 * independent from release channel: unknown / older servers and fetch errors
 * fail closed to `false`, while `settled` lets redirecting callers avoid a
 * loading-time bounce.
 */
export function useGrowthLandingPagesState(): { enabled: boolean; settled: boolean } {
  const { config, settled } = useServerBootstrapConfig();
  return { enabled: config?.growthLandingPagesEnabled ?? false, settled };
}

export function useGrowthLandingPagesEnabled(): boolean {
  return useGrowthLandingPagesState().enabled;
}

export function useAuthProviderAvailabilityState(): {
  providers: AuthProviderAvailability;
  settled: boolean;
} {
  const { config, settled } = useServerBootstrapConfig();
  return {
    providers: config?.authProviders ?? { google: false, github: false },
    settled,
  };
}
