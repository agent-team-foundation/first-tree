// Core functions — programmatic API for external CLI consumers

// SDK — re-export for convenience
export type { AccessTokenProvider, PullResult, RegisterResult, SdkConfig } from "@first-tree-hub/client";
export { FirstTreeHubSDK, SdkError } from "@first-tree-hub/client";
// Core types
export type { CheckResult, ServiceInfo, ServiceState, StartOptions } from "./core/index.js";
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
  getClientServiceStatus,
  hasUser,
  installClientService,
  isDockerAvailable,
  isInteractive,
  isServiceSupported,
  onboardCheck,
  onboardCreate,
  printResults,
  promptAddAgent,
  promptMissingFields,
  resolveAccessToken,
  resolveCliInvocation,
  resolveServerUrl,
  runHomeMigration,
  runMigrations,
  startServer,
  status,
  stopPostgres,
  uninstallClientService,
} from "./core/index.js";
