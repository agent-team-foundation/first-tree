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
 * `GET /attention?chat=<chatId>&state=open` — list open Attentions anchored
 * to one chat. The web client fetches the open set, then the bottom-card
 * picks the oldest one to display (M1 末: agents are expected to only have
 * one open at a time, but we defend against the rare overlap).
 */
export async function listAttentionsInChat(chatId: string): Promise<Attention[]> {
  const qs = new URLSearchParams({ chat: chatId, state: "open" });
  return api.get<Attention[]>(`/attention?${qs.toString()}`);
}
