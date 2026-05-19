// Agent messaging helpers
export { resolveReplyToFromEnv } from "./agent-messaging.js";
// Local agent alias hygiene (stale alias detection + deletion)
export type { PinnedAgent, StaleAlias, StaleAliasReason } from "./agent-prune.js";
export { findStaleAliases, formatStaleReason, removeLocalAgent } from "./agent-prune.js";
// Bootstrap / credentials
export {
  AuthRefreshFailedError,
  AuthRefreshRateLimitedError,
  ensureFreshAccessToken,
  ensureFreshAdminToken,
  loadCredentials,
  maskToken,
  resolveAccessToken,
  resolveServerUrl,
  saveAgentConfig,
  saveCredentials,
} from "./bootstrap.js";
export { cliFetch } from "./cli-fetch.js";
// Local client identity rotation (on CLIENT_ORG_MISMATCH)
export { handleClientOrgMismatch, rotateClientIdWithBackup } from "./client-reidentify.js";
export type { ClientRuntimeOptions } from "./client-runtime.js";
// Client runtime
export { ClientRuntime } from "./client-runtime.js";
// Diagnostics (doctor)
export type { CheckResult } from "./doctor.js";
export {
  checkAgentConfigs,
  checkBackgroundService,
  checkClientConfig,
  checkNodeVersion,
  checkServerReachable,
  checkWebSocket,
  printResults,
  reconcileAgentConfigs,
} from "./doctor.js";
// Feishu
export { bindFeishuBot, bindFeishuUser } from "./feishu.js";
// Phase 3 of the agent-naming refactor — renames local agent dirs whose
// name drifted from the server-authoritative `agent.name` slug.
export type { AgentDirMigrationResult, NameResolver } from "./migrate-agent-dirs.js";
export { createApiNameResolver, migrateLocalAgentDirs } from "./migrate-agent-dirs.js";
// Legacy home auto-migration (pre-v0.9 `~/.first-tree-hub` → `~/.first-tree/hub`)
export { runHomeMigration } from "./migrate-home.js";
// Onboard
export {
  formatCheckReport,
  loadOnboardState,
  onboardCheck,
  onboardCreate,
  saveOnboardState,
} from "./onboard.js";
// Output helpers
export { blank, status } from "./output.js";
// Interactive prompts
export { isInteractive, promptAddAgent, promptMissingFields } from "./prompt.js";
// Pre-flight runtime-provider reconciliation (P2 — capabilities + YAML rewrite)
export { reconcileLocalRuntimeProviders, uploadClientCapabilities } from "./runtime-provider-reconcile.js";
// Background service install (launchd / systemd --user)
export type { ServiceInfo, ServiceOpResult, ServiceState } from "./service-install.js";
export {
  deriveServiceSuffix,
  getClientServiceStatus,
  installClientService,
  isServiceSupported,
  resolveCliInvocation,
  restartClientService,
  startClientService,
  stopClientService,
  uninstallClientService,
} from "./service-install.js";
export type { ExecuteUpdateResult, InstallMode } from "./update.js";
// Self-update glue — exported so both `client start` and `connect <token>`
// can pass identical prompt / install callbacks to the ClientRuntime.
export {
  detectInstallMode,
  fetchLatestVersion,
  installGlobalLatest,
  installGlobalSpec,
  PACKAGE_NAME,
} from "./update.js";
export { createExecuteUpdate, declineUpdate, promptUpdate, SELF_RESTART_EXIT_CODE } from "./update-glue.js";
// Command package version (bundle self-identification)
export { CLI_USER_AGENT, COMMAND_VERSION } from "./version.js";
