// Core functions — programmatic API for external CLI consumers

// SDK — re-export for convenience
export type { PullResult, RegisterResult, SdkConfig } from "@first-tree-hub/client";
export { FirstTreeHubSDK, SdkError } from "@first-tree-hub/client";
// Core types
export type { CheckResult, StartOptions } from "./core/index.js";
export {
  // Feishu
  bindFeishuBot,
  bindFeishuUser,
  blank,
  // Bootstrap
  bootstrapToken,
  // Client runtime
  ClientRuntime,
  checkAgentConfigs,
  checkAgentTokens,
  checkBootstrapStatus,
  checkClientConfig,
  checkContextTreeRepo,
  checkDatabase,
  checkDocker,
  checkGitHubToken,
  // Diagnostics (doctor)
  checkNodeVersion,
  checkServerConfig,
  checkServerHealth,
  checkServerReachable,
  checkWebSocket,
  createAdminUser,
  ensurePostgres,
  formatCheckReport,
  getGitHubToken,
  getGitHubUsername,
  // Admin management
  hasAdminUser,
  // Docker PostgreSQL
  isDockerAvailable,
  isInteractive,
  onboardCheck,
  onboardCreate,
  printResults,
  promptAddAgent,
  // Interactive prompts
  promptMissingFields,
  resolveAgentToken,
  resolveServerUrl,
  // Database
  runMigrations,
  // Server lifecycle
  startServer,
  // Output helpers
  status,
  stopPostgres,
} from "./core/index.js";
