import type { AdapterBotStatus } from "@agent-team-foundation/first-tree-hub-shared";
import { api, withOrg } from "./client.js";

export function getAdapterStatuses(): Promise<AdapterBotStatus[]> {
  return api.get<AdapterBotStatus[]>(withOrg("/adapters/status"));
}
