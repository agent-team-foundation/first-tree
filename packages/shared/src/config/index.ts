// Schema declaration utilities

export type { AgentConfig } from "./agent-config.js";
export { agentConfigSchema } from "./agent-config.js";
export type { ClientConfig } from "./client-config.js";
export { clientConfigSchema, getClientConfig, updatePolicySchema } from "./client-config.js";
// Agent loader
export { loadAgents } from "./loader.js";
// Legacy home auto-migration (pre-v0.9 `~/.first-tree` → `~/.first-tree/hub`)
export type { HomeMigrationResult } from "./migrate-home.js";
export { LEGACY_HOME_DIR, migrateLegacyHome } from "./migrate-home.js";
export type { UpdatePolicy } from "./phase.js";
export { UPDATE_POLICY_DEFAULT } from "./phase.js";
export type { ConfigMeta } from "./resolver.js";
// Config initialization and access
export {
  buildZodSchema,
  collectMissingPrompts,
  defaultConfigDir,
  defaultDataDir,
  defaultHome,
  getConfigMeta,
  getConfigValue,
  initConfig,
  readConfigFile,
  resetConfigMeta,
  resolveConfigReadonly,
  setConfigValue,
} from "./resolver.js";
export { defineConfig, field, optional } from "./schema.js";
export type { ServerConfig } from "./server-config.js";
// Typed config schemas and accessors
export { getServerConfig, serverConfigSchema } from "./server-config.js";
export { getConfig, resetConfig } from "./singleton.js";

// Types
export type {
  AutoGenerator,
  ConfigSource,
  FieldDef,
  FieldOptions,
  InferConfig,
  InitConfigOptions,
  OptionalGroupDef,
  PromptChoice,
  PromptDef,
  ResolvedFieldInfo,
} from "./types.js";
