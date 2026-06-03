import type { HubClient } from "../../api/activity.js";

export function isBindableClient(client: Pick<HubClient, "status">): boolean {
  return client.status === "connected";
}
