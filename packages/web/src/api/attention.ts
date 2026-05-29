import type { Attention } from "@first-tree/shared";
import { api } from "./client.js";

/**
 * React-Query key for the list of Attentions anchored to a given chat. The
 * web client always asks for `state=open` here — closed records are not part
 * of the "needs your reply" surface at M1 末.
 */
export function attentionsInChatQueryKey(chatId: string): readonly string[] {
  return ["attentions", "chat", chatId];
}

/** React-Query mutation key for `POST /attention/:id/respond`. */
export function respondAttentionMutationKey(id: string): readonly string[] {
  return ["attentions", "respond", id];
}

/**
 * `POST /attention/:id/respond` — submit either a free-text reply (`text`)
 * or a structured `answers` object (keyed by question id; `"default"` for
 * single-question Attentions). One of the two must be present; the server
 * rejects an empty body.
 *
 * Class A user-JWT surface (`api/attention.ts` on the server): the JWT
 * carries the caller's user id; visibility resolves to whichever human
 * agent the user owns is the target on the row. No `/orgs/:orgId/` prefix.
 */
export function respondAttention(
  id: string,
  body: { text?: string; answers?: Record<string, unknown> },
): Promise<Attention> {
  return api.post<Attention>(`/attention/${encodeURIComponent(id)}/respond`, body);
}

/**
 * `GET /attention?chat=<chatId>&state=all` — every Attention anchored to
 * one chat (open + closed, server caps at 200 rows newest-first).
 *
 * Both consumers share this fetch:
 *   - chat-bottom AttentionCard filters to `state==='open' && requiresResponse`
 *     client-side and picks the oldest
 *   - sidebar AttentionsSection wants the full history list for the chat
 *
 * Cross-consumer reuse via `attentionsInChatQueryKey` keeps WS-driven
 * invalidations hitting one cache.
 */
export async function listAttentionsInChat(chatId: string): Promise<Attention[]> {
  const qs = new URLSearchParams({ chat: chatId, state: "all" });
  return api.get<Attention[]>(`/attention?${qs.toString()}`);
}

/** React-Query key for the cross-chat "Attentions waiting on me" list. */
export const myAttentionsQueryKey = ["attentions", "me"] as const;

/**
 * `GET /attention?state=open&limit=200` — every open Attention visible to
 * the caller across all of their chats. The server's user-JWT route in
 * `api/attention.ts` already scopes by the caller's human agent
 * identities, so no `target` / `chat` filter is needed for the "needs my
 * reply" set.
 *
 * `limit=200` is the server-enforced max (`listAttentionsQuerySchema`);
 * the default of 50 would silently truncate the jump-to candidate list
 * for multi-chat users.
 *
 * Used by the topbar Jump-to palette to surface waiting NHAs alongside
 * chats and agents.
 */
export async function listMyAttentions(): Promise<Attention[]> {
  const qs = new URLSearchParams({ state: "open", limit: "200" });
  return api.get<Attention[]>(`/attention?${qs.toString()}`);
}
