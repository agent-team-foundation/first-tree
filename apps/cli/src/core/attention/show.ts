import type { FirstTreeHubSDK } from "@first-tree/client";
import type { Attention } from "@first-tree/shared";

/**
 * Fetch a single Attention by id. The server returns 404 for unknown ids and
 * 403 when the calling agent has no visibility into the record.
 */
export async function showAttention(sdk: FirstTreeHubSDK, id: string): Promise<Attention> {
  return sdk.attention.show(id);
}
