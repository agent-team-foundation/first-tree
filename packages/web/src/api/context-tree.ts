import type { ContextTreeSnapshot } from "@first-tree/shared";
import { api, withOrgAt } from "./client.js";

export type ContextTreeWindow = "1d" | "7d" | "30d";

export function getContextTreeSnapshot(
  organizationId: string,
  window: ContextTreeWindow,
): Promise<ContextTreeSnapshot> {
  const query = `?window=${encodeURIComponent(window)}`;
  return api.get<ContextTreeSnapshot>(withOrgAt(organizationId, `/context-tree/snapshot${query}`));
}
