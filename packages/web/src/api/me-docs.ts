import type { GetMeDoc, GetMeDocResponse } from "@first-tree/shared";
import { api } from "./client.js";

export function getMeDoc(chatId: string, query: GetMeDoc): Promise<GetMeDocResponse> {
  const params = new URLSearchParams({ agentId: query.agentId, path: query.path });
  if (query.basePath) params.set("basePath", query.basePath);
  return api.get<GetMeDocResponse>(`/chats/${encodeURIComponent(chatId)}/docs/preview?${params.toString()}`);
}
