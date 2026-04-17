// Core functions — programmatic API for external CLI consumers

// SDK — re-export for convenience
export type { AccessTokenProvider, PullResult, RegisterResult, SdkConfig } from "@first-tree-hub/client";
export { FirstTreeHubSDK, SdkError } from "@first-tree-hub/client";
// Core types
export type { CheckResult, StartOptions } from "./core/index.js";
export {
  bindFeishuBot,
  bindFeishuUser,
  blank,
  ClientRuntime,
  checkAgentConfigs,
  checkClientConfig,
  checkDatabase,
  checkDocker,
  checkNodeVersion,
  checkServerConfig,
  checkServerHealth,
  checkServerReachable,
  checkWebSocket,
  createOwner,
  ensureFreshAccessToken,
  ensureFreshAdminToken,
  ensurePostgres,
  formatCheckReport,
  hasUser,
  isDockerAvailable,
  isInteractive,
  onboardCheck,
  onboardCreate,
  printResults,
  promptAddAgent,
  promptMissingFields,
  resolveAccessToken,
  resolveServerUrl,
  runMigrations,
  startServer,
  status,
  stopPostgres,
} from "./core/index.js";
