import type { ContextTreeSnapshot } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

export type ContextTreeWindow = "1d" | "7d" | "30d";

export function getContextTreeSnapshot(window: ContextTreeWindow): Promise<ContextTreeSnapshot> {
  const query = `?window=${encodeURIComponent(window)}`;
  return api.get<ContextTreeSnapshot>(`/context-tree/snapshot${query}`);
}
