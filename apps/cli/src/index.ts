// Core functions — programmatic API for external CLI consumers

// SDK — re-export for convenience
export type { AccessTokenProvider, RegisterResult, SdkConfig } from "@first-tree/client";
export { FirstTreeHubSDK, FirstTreeHubSDK as FirstTreeSDK, SdkError } from "@first-tree/client";
// Connect-token helpers — derive the server URL from a connect token's `iss`.
// `decodeJwtPayload` is intentionally NOT re-exported: it's an internal
// helper used by the CLI account-switch prompt, and its only legitimate
// public use case (URL derivation) already has a dedicated export.
export { deriveHubUrlFromToken, HubUrlDerivationError } from "./commands/_shared/connect-token.js";
// Core types
export type {
  CheckResult,
  MigrationDetection,
  MigrationResult,
  ServiceInfo,
  ServiceOpResult,
  ServiceState,
  WorkspaceBoundSource,
  WorkspaceStatus,
  WorkspaceUnboundSibling,
} from "./core/index.js";
export {
  AuthRefreshFailedError,
  AuthRefreshRateLimitedError,
  blank,
  ClientRuntime,
  checkAgentConfigs,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  computeWorkspaceStatus,
  detectMigrationState,
  discoverWorkspaceRoot,
  ensureFreshAccessToken,
  ensureFreshAdminToken,
  formatCheckReport,
  getClientServiceStatus,
  handleClientOrgMismatch,
  installClientService,
  isInteractive,
  isServiceSupported,
  migrateWorkspaceToW1,
  onboardCheck,
  onboardCreate,
  pickImmediateWorkspaceSources,
  printResults,
  promoteToWorkspace,
  promptAddAgent,
  promptMissingFields,
  readWorkspaceManifest,
  resolveAccessToken,
  resolveCliInvocation,
  resolveServerUrl,
  restartClientService,
  startClientService,
  status,
  stopClientService,
  uninstallClientService,
  writeWorkspaceManifest,
} from "./core/index.js";
