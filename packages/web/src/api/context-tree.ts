import type { ContextTreeSnapshot } from "@agent-team-foundation/first-tree-hub-shared";
import { api, withOrgAt } from "./client.js";

export type ContextTreeWindow = "1d" | "3d" | "7d" | "30d";

export function getContextTreeSnapshot(
  organizationId: string,
  window: ContextTreeWindow,
): Promise<ContextTreeSnapshot> {
  const query = `?window=${encodeURIComponent(window)}`;
  return api.get<ContextTreeSnapshot>(withOrgAt(organizationId, `/context-tree/snapshot${query}`));
}
