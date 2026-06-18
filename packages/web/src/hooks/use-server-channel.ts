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
 * The release channel this server speaks (`dev` | `staging` | `prod`), or null
 * while loading / when the server does not report one. Server-wide and fixed
 * for the life of a deploy, so it is fetched once from the public bootstrap
 * `/config` endpoint and cached for the session. Gates channel-scoped UI such
 * as the staging-only "hide agent final text" view toggle.
 */
export function useServerChannel(): ChannelName | null {
  const { data } = useQuery({
    queryKey: ["server-channel"],
    queryFn: fetchServerChannel,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  return data ?? null;
}
