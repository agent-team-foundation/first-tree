import type { ChannelName } from "@first-tree/shared/channel";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client.js";

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

async function fetchServerChannel(): Promise<ChannelName | null> {
  const data = await api.get<unknown>("/bootstrap/config");
  return extractChannel(data);
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
  const { data, status } = useQuery({
    queryKey: ["server-channel"],
    queryFn: fetchServerChannel,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  // With infinite staleTime `pending` is the only not-yet-resolved status;
  // `success` (a channel or an unrecognised body → null) and `error` both
  // count as settled, so the prod-safe default applies the moment we know.
  return { channel: data ?? null, settled: status !== "pending" };
}

/**
 * The release channel this server speaks (`dev` | `staging` | `prod`), or null
 * while loading / when the server does not report one. Gates channel-scoped UI
 * such as the staging-only "hide agent final text" view toggle; for a gate that
 * must distinguish loading from unknown, use {@link useServerChannelState}.
 */
export function useServerChannel(): ChannelName | null {
  return useServerChannelState().channel;
}
