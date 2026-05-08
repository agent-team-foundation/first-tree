import type {
  AdapterConfig,
  CreateAdapterConfig,
  UpdateAdapterConfig,
} from "@agent-team-foundation/first-tree-hub-shared";
import { api, withOrg } from "./client.js";

export function listAdapters(): Promise<AdapterConfig[]> {
  return api.get<AdapterConfig[]>(withOrg("/adapters"));
}

export function getAdapter(id: number): Promise<AdapterConfig> {
  return api.get<AdapterConfig>(`/adapters/${id}`);
}

export function createAdapter(data: CreateAdapterConfig): Promise<AdapterConfig> {
  return api.post<AdapterConfig>(withOrg("/adapters"), data);
}

export function updateAdapter(id: number, data: UpdateAdapterConfig): Promise<AdapterConfig> {
  return api.patch<AdapterConfig>(`/adapters/${id}`, data);
}

export function deleteAdapter(id: number): Promise<void> {
  return api.delete<void>(`/adapters/${id}`);
}
