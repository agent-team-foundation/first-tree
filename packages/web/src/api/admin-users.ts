import type { AdminUser, CreateAdminUser, UpdateAdminUser } from "@first-tree-hub/shared";
import { api } from "./client.js";

export function listAdminUsers(): Promise<AdminUser[]> {
  return api.get<AdminUser[]>("/admin/users");
}

export function createAdminUser(data: CreateAdminUser): Promise<AdminUser> {
  return api.post<AdminUser>("/admin/users", data);
}

export function updateAdminUser(id: string, data: UpdateAdminUser): Promise<AdminUser> {
  return api.patch<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, data);
}

export function deleteAdminUser(id: string): Promise<void> {
  return api.delete<void>(`/admin/users/${encodeURIComponent(id)}`);
}
