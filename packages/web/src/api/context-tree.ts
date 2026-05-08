import type { ContextTreeSnapshot } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

export function getContextTreeSnapshot(since?: string): Promise<ContextTreeSnapshot> {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  return api.get<ContextTreeSnapshot>(`/context-tree/snapshot${query}`);
}
