import { api } from "./client.js";

export type Notification = {
  id: string;
  organizationId: string;
  type: string;
  severity: string;
  agentId: string | null;
  chatId: string | null;
  message: string;
  read: boolean;
  createdAt: string;
};

export type NotificationListResponse = {
  items: Notification[];
  nextCursor: string | null;
};

export function listNotifications(params?: {
  limit?: number;
  cursor?: string;
  severity?: string;
  read?: boolean;
  agentId?: string;
}): Promise<NotificationListResponse> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.severity) qs.set("severity", params.severity);
  if (params?.read !== undefined) qs.set("read", String(params.read));
  if (params?.agentId) qs.set("agentId", params.agentId);
  const query = qs.toString();
  return api.get<NotificationListResponse>(`/admin/notifications${query ? `?${query}` : ""}`);
}

export function markNotificationRead(id: string): Promise<unknown> {
  return api.post(`/admin/notifications/${id}/read`);
}

export function markAllNotificationsRead(): Promise<unknown> {
  return api.post("/admin/notifications/read-all");
}
