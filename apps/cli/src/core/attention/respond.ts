import { type Attention, attentionRecordSchema, type RespondAttentionInput } from "@first-tree/shared";
import { ensureFreshAccessToken, resolveServerUrl } from "../bootstrap.js";
import { cliFetch } from "../cli-fetch.js";

export type RespondArgs = {
  id: string;
  text?: string;
  answers?: Record<string, unknown>;
};

/**
 * Respond to an open Attention as the target human.
 *
 * Distinct from the other attention operations because the responder is a
 * member (the human target), not an agent — so the request travels over the
 * member-scoped HTTP path with the user JWT only, no `X-Agent-Id` header.
 * The endpoint mirrors the other attention routes structurally and validates
 * the body against the shared `respondAttentionInputSchema` server-side.
 */
export async function respondAttention(args: RespondArgs): Promise<Attention> {
  const serverUrl = resolveServerUrl();
  const token = await ensureFreshAccessToken();

  const body: RespondAttentionInput = args.text !== undefined ? { text: args.text } : { answers: args.answers ?? {} };

  const res = await cliFetch(`${serverUrl}/api/v1/attention/${encodeURIComponent(args.id)}/respond`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // keep raw body
    }
    throw new AttentionRespondError(res.status, message);
  }

  const json = (await res.json()) as unknown;
  return attentionRecordSchema.parse(json);
}

/**
 * Narrow error class for `respond` — separate from `SdkError` so the CLI
 * command can map HTTP statuses to its own exit codes without dragging the
 * full SDK error hierarchy through this user-token path.
 */
export class AttentionRespondError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "AttentionRespondError";
  }
}
