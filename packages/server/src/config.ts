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
};
