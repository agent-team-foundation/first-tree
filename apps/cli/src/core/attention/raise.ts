import type { FirstTreeHubSDK } from "@first-tree/client";
import type { Attention, AttentionMetadata } from "@first-tree/shared";

/**
 * Arguments accepted by {@link raiseAttention}. The CLI flattens / merges its
 * `--meta key=value` and `--meta-json @file` flags into a single
 * `metadata` bag before calling here; the core function itself is dumb about
 * how the bag was assembled.
 */
export type RaiseArgs = {
  chatId: string;
  target: string;
  subject: string;
  body: string;
  requiresResponse: boolean;
  metadata: AttentionMetadata;
};

/**
 * Raise a Need-Human-Attention request via the agent-scoped SDK.
 *
 * Validation lives in the shared `raiseAttentionInputSchema` (parsed
 * server-side) — this layer is a pure pass-through so the CLI command stays
 * thin and the SDK retains a single source of truth for shape errors.
 */
export async function raiseAttention(sdk: FirstTreeHubSDK, args: RaiseArgs): Promise<Attention> {
  return sdk.attention.raise({
    chatId: args.chatId,
    target: args.target,
    subject: args.subject,
    body: args.body,
    requiresResponse: args.requiresResponse,
    metadata: args.metadata,
  });
}
