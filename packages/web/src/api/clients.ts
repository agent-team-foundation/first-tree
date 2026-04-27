import { api } from "./client.js";

/**
 * Subset of `/api/v1/clients` the wizard cares about — full schema lives in
 * the admin clients page. `userId` is preserved on purpose: the server's
 * `/clients` admin scope returns every client in the org for `role==="admin"`
 * users (so admins can see whose machine is whose on the regular admin
 * page). The Connect wizard MUST then filter to the current user, or a
 * fresh workspace creator (auto-admin) would falsely auto-advance the
 * moment any peer's client connects. Filtering happens in
 * `welcome-connect.tsx`.
 */
export type ConnectedClientSummary = {
  id: string;
  userId: string;
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
        userId: string;
        status: string;
        hostname: string | null;
        os: string | null;
        connectedAt: string | null;
      }>
    >("/clients/");
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    status: r.status === "connected" ? "connected" : "disconnected",
    hostname: r.hostname,
    os: r.os,
    connectedAt: r.connectedAt,
  }));
}

export type ConnectTokenResponse = {
  token: string;
  expiresIn: number;
  /** Pre-baked `first-tree-hub client connect <url> --token <…>` command for copy-paste. */
  command: string;
};

export async function generateConnectToken(): Promise<ConnectTokenResponse> {
  // Route is `/connect-tokens` (no `/me` prefix) — `meRoutes` mounts both
  // `/me` and `/connect-tokens` at the empty prefix in `app.ts`.
  return api.post<ConnectTokenResponse>("/connect-tokens");
}
