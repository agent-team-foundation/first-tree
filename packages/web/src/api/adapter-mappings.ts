import type { AdapterMapping, CreateAdapterMapping } from "@agent-team-foundation/first-tree-hub-shared";
import { api } from "./client.js";

export function listAdapterMappings(): Promise<AdapterMapping[]> {
  return api.get<AdapterMapping[]>("/admin/adapter-mappings");
}

export function createAdapterMapping(data: CreateAdapterMapping): Promise<AdapterMapping> {
  return api.post<AdapterMapping>("/admin/adapter-mappings", data);
}

export function deleteAdapterMapping(id: number): Promise<void> {
  return api.delete<void>(`/admin/adapter-mappings/${id}`);
}
