import type { FirstTreeHubSDK } from "@first-tree/client";
import type { Attention } from "@first-tree/shared";

export type CancelArgs = {
  id: string;
  reason?: string;
};

/**
 * Cancel an open Attention previously raised by the calling agent. Only the
 * origin agent may cancel — the server enforces this; the CLI surfaces the
 * server error verbatim.
 */
export async function cancelAttention(sdk: FirstTreeHubSDK, args: CancelArgs): Promise<Attention> {
  return sdk.attention.cancel(args.id, args.reason);
}
