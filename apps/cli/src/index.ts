// Core functions — programmatic API for external CLI consumers

// SDK — re-export for convenience
export type { AccessTokenProvider, RegisterResult, SdkConfig } from "@first-tree/client";
export { FirstTreeHubSDK, SdkError } from "@first-tree/client";
// SaaS connect helpers — derive the hub URL from a connect token's `iss`.
// `decodeJwtPayload` is intentionally NOT re-exported: it's an internal
// helper used by the CLI account-switch prompt, and its only legitimate
// public use case (URL derivation) already has a dedicated export.
export { deriveHubUrlFromToken, HubUrlDerivationError } from "./commands/saas-connect.js";
// Core types
export type { CheckResult, ServiceInfo, ServiceOpResult, ServiceState } from "./core/index.js";
export {
  AuthRefreshFailedError,
  AuthRefreshRateLimitedError,
  bindFeishuBot,
  bindFeishuUser,
  blank,
  ClientRuntime,
  checkAgentConfigs,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  ensureFreshAccessToken,
  ensureFreshAdminToken,
  formatCheckReport,
  getClientServiceStatus,
  handleClientOrgMismatch,
  installClientService,
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
  restartClientService,
  rotateClientIdWithBackup,
  runHomeMigration,
  startClientService,
  status,
  stopClientService,
  uninstallClientService,
} from "./core/index.js";
