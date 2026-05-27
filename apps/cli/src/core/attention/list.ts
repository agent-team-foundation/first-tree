import type { FirstTreeHubSDK } from "@first-tree/client";
import type { Attention, ListAttentionsQuery } from "@first-tree/shared";

export type ListArgs = Partial<ListAttentionsQuery>;

/**
 * List Attentions visible to the calling agent. The filter is forwarded
 * unchanged — defaults (e.g. `state="open"`) are applied server-side.
 */
export async function listAttentions(sdk: FirstTreeHubSDK, args: ListArgs): Promise<Attention[]> {
  return sdk.attention.list(args);
}
