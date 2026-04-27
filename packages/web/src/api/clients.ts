import { api } from "./client.js";

/**
 * Subset of `/api/v1/clients` the wizard cares about — full schema lives in
 * the admin clients page. The wizard only needs to know whether at least
 * one client owned by the current user is currently connected.
 */
export type ConnectedClientSummary = {
  id: string;
  status: "connected" | "disconnected";
  hostname: string | null;
  os: string | null;
  connectedAt: string | null;
};

export async function listMyClients(): Promise<ConnectedClientSummary[]> {
  const rows =
    await api.get<
      Array<{
        id: string;
        status: string;
        hostname: string | null;
        os: string | null;
        connectedAt: string | null;
      }>
    >("/clients/");
  return rows.map((r) => ({
    id: r.id,
    status: r.status === "connected" ? "connected" : "disconnected",
    hostname: r.hostname,
    os: r.os,
    connectedAt: r.connectedAt,
  }));
}

export type ConnectTokenResponse = {
  token: string;
  expiresIn: number;
  /** Pre-baked `first-tree-hub connect <url> --token <…>` command for copy-paste. */
  command: string;
};

export async function generateConnectToken(): Promise<ConnectTokenResponse> {
  // Mounted alongside `/me` (no `/me` prefix) — see packages/server/src/api/me.ts.
  return api.post<ConnectTokenResponse>("/connect-tokens");
}
