import type { ServerConfig } from "@first-tree/shared/config";

/**
 * Server runtime config extends the shared ServerConfig with
 * fields that are generated per-process (not persisted to YAML).
 *
 * `commandVersion` and the rest of the version-advertisement knobs now live
 * under `serverConfig.update.*` (see `shared/src/config/server-config.ts`),
 * so the runtime extension stays focused on per-process generated fields.
 */
export type Config = ServerConfig & {
  /** Unique ID for this server instance — generated at startup */
  instanceId: string;
  /** Web static files dist path — resolved by CLI startup */
  webDistPath?: string;
};
