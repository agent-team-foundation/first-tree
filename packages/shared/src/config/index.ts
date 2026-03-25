// Schema declaration utilities

export type { AgentConfig } from "./agent-config.js";
export { agentConfigSchema } from "./agent-config.js";
export type { ClientConfig } from "./client-config.js";
export { clientConfigSchema, getClientConfig } from "./client-config.js";

// Agent loader
export { loadAgents } from "./loader.js";
export type { ConfigMeta } from "./resolver.js";
// Config initialization and access
export {
  buildZodSchema,
  collectMissingPrompts,
  DEFAULT_CONFIG_DIR,
  getConfigMeta,
  getConfigValue,
  initConfig,
  readConfigFile,
  resetConfigMeta,
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
