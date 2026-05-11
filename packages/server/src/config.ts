import type { ServerConfig } from "@agent-team-foundation/first-tree-hub-shared/config";

/**
 * Server runtime config extends the shared ServerConfig with
 * fields that are generated per-process (not persisted to YAML).
 */
export type Config = ServerConfig & {
  /** Unique ID for this server instance — generated at startup */
  instanceId: string;
  /** Web static files dist path — resolved by CLI startup */
  webDistPath?: string;
  /**
   * Command package version this server was bundled with. Injected by the
   * Command CLI at startup (which reads its own `package.json`). Advertised
   * to every connecting client via the `server:welcome` WS frame so clients
   * can detect version drift and self-update. Optional because the server
   * can also be launched standalone via `pnpm --filter … dev`, in which case
   * the bootstrap falls back to the server workspace's own package.json.
   */
  commandVersion?: string;
};
