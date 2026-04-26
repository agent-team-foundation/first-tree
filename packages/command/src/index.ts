// Core functions — programmatic API for external CLI consumers

// SDK — re-export for convenience
export type { AccessTokenProvider, PullResult, RegisterResult, SdkConfig } from "@first-tree-hub/client";
export { FirstTreeHubSDK, SdkError } from "@first-tree-hub/client";
// Core types — public API for external Hub consumers (e.g. context-tree).
// Note: `bootstrapServer` is intentionally NOT exported here — it's an
// internal seam between `start` and the (future) daemon entry point and
// will likely shift shape in Phase 1b.
export type { CheckResult, LocalAdmin, ServiceInfo, ServiceState, StartOptions } from "./core/index.js";
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
  createAdmin,
  ensureFreshAccessToken,
  ensureFreshAdminToken,
  ensurePostgres,
  findAdmin,
  formatCheckReport,
  getClientServiceStatus,
  handleClientOrgMismatch,
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
  rotateClientIdWithBackup,
  runHomeMigration,
  runMigrations,
  startServer,
  status,
  stopPostgres,
  uninstallClientService,
} from "./core/index.js";
