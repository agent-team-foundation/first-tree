import type { AdapterConfig, CreateAdapterConfig, UpdateAdapterConfig } from "@first-tree-hub/shared";
import { api } from "./client.js";

export function listAdapters(): Promise<AdapterConfig[]> {
  return api.get<AdapterConfig[]>("/admin/adapters");
}

export function getAdapter(id: number): Promise<AdapterConfig> {
  return api.get<AdapterConfig>(`/admin/adapters/${id}`);
}

export function createAdapter(data: CreateAdapterConfig): Promise<AdapterConfig> {
  return api.post<AdapterConfig>("/admin/adapters", data);
}

export function updateAdapter(id: number, data: UpdateAdapterConfig): Promise<AdapterConfig> {
  return api.patch<AdapterConfig>(`/admin/adapters/${id}`, data);
}

export function deleteAdapter(id: number): Promise<void> {
  return api.delete<void>(`/admin/adapters/${id}`);
}
