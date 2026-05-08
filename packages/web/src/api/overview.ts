import { api } from "./client.js";

export type OverviewStats = {
  agents: number;
  onlineAgents: number;
  chats: number;
};

export function getOverview(): Promise<OverviewStats> {
  return api.get<OverviewStats>("/overview");
}
