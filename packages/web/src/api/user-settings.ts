import type { AuthProvider, AuthProviderActionResult, AuthProviderConnectionsResponse } from "@first-tree/shared";
import { api } from "./client.js";

export function getAuthProviders(): Promise<AuthProviderConnectionsResponse> {
  return api.get<AuthProviderConnectionsResponse>("/me/auth-providers");
}

export function startProviderLink(provider: AuthProvider): Promise<AuthProviderActionResult> {
  return api.post<AuthProviderActionResult>(`/me/auth-providers/${provider}/link/start`, {});
}

export function startProviderUnlink(provider: AuthProvider): Promise<AuthProviderActionResult> {
  return api.post<AuthProviderActionResult>(`/me/auth-providers/${provider}/unlink/start`, {});
}
