import type { ContextTreeSnapshot, InitializeContextTreeResponse } from "@first-tree/shared";
import { api, withOrgAt } from "./client.js";

export type ContextTreeWindow = "1d" | "7d" | "30d";

export function getContextTreeSnapshot(
  organizationId: string,
  window: ContextTreeWindow,
): Promise<ContextTreeSnapshot> {
  const query = `?window=${encodeURIComponent(window)}`;
  return api.get<ContextTreeSnapshot>(withOrgAt(organizationId, `/context-tree/snapshot${query}`));
}

export function initializeContextTree(organizationId: string): Promise<InitializeContextTreeResponse> {
  return api.post<InitializeContextTreeResponse>(withOrgAt(organizationId, "/context-tree/initialize"), {});
}
