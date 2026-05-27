// Core functions — programmatic API for external CLI consumers

// SDK — re-export for convenience
export type { AccessTokenProvider, RegisterResult, SdkConfig } from "@first-tree/client";
export { FirstTreeHubSDK, SdkError } from "@first-tree/client";
// Connect-token helpers — derive the hub URL from a connect token's `iss`.
// `decodeJwtPayload` is intentionally NOT re-exported: it's an internal
// helper used by the CLI account-switch prompt, and its only legitimate
// public use case (URL derivation) already has a dedicated export.
export { deriveHubUrlFromToken, HubUrlDerivationError } from "./commands/_shared/connect-token.js";
// Core types
export type {
  CancelArgs,
  CheckResult,
  ListArgs,
  RaiseArgs,
  RespondArgs,
  ServiceInfo,
  ServiceOpResult,
  ServiceState,
} from "./core/index.js";
export {
  AttentionRespondError,
  AuthRefreshFailedError,
  AuthRefreshRateLimitedError,
  bindFeishuBot,
  bindFeishuUser,
  blank,
  ClientRuntime,
  cancelAttention,
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
  listAttentions,
  onboardCheck,
  onboardCreate,
  printResults,
  promptAddAgent,
  promptMissingFields,
  raiseAttention,
  resolveAccessToken,
  resolveCliInvocation,
  resolveServerUrl,
  respondAttention,
  restartClientService,
  rotateClientIdWithBackup,
  showAttention,
  startClientService,
  status,
  stopClientService,
  uninstallClientService,
} from "./core/index.js";
