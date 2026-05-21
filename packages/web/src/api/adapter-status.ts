import type { AdapterBotStatus } from "@first-tree/shared";
import { api, withOrg } from "./client.js";

export function getAdapterStatuses(): Promise<AdapterBotStatus[]> {
  return api.get<AdapterBotStatus[]>(withOrg("/adapters/status"));
}
