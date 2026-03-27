import type { AdapterBotStatus } from "@first-tree-core/shared";
import { api } from "./client.js";

export function getAdapterStatuses(): Promise<AdapterBotStatus[]> {
  return api.get<AdapterBotStatus[]>("/admin/adapters/status");
}
