import type { AuthProvider, AuthProviderActionResult, AuthProviderConnectionsResponse } from "@first-tree/shared";
import { api } from "./client.js";

export function getAuthProviders(): Promise<AuthProviderConnectionsResponse> {
  return api.get<AuthProviderConnectionsResponse>("/me/auth-providers");
}

export function startProviderLink(provider: AuthProvider, next?: string): Promise<AuthProviderActionResult> {
  const query = next ? `?next=${encodeURIComponent(next)}` : "";
  return api.post<AuthProviderActionResult>(`/me/auth-providers/${provider}/link/start${query}`, {});
}

export function startProviderUnlink(provider: AuthProvider): Promise<AuthProviderActionResult> {
  return api.post<AuthProviderActionResult>(`/me/auth-providers/${provider}/unlink/start`, {});
}
