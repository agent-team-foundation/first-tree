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
export type { CapabilityRefresherDeps } from "./capability-refresh.js";
// Runtime-capability refresh (reconnect re-probe + bounded background poll)
export { CapabilityRefresher, stableCapabilitiesJson } from "./capability-refresh.js";
export { cliFetch } from "./cli-fetch.js";
// Local client identity recovery helpers
export { handleClientOrgMismatch } from "./client-reidentify.js";
export type { ClientRuntimeOptions, ClientRuntimeOutput } from "./client-runtime.js";
// Client runtime
export { ClientRuntime, createLoggerRuntimeOutput } from "./client-runtime.js";
export type { LiveRuntimeMarker, LocalClientOwner, StopClientRuntimeProcessResult } from "./client-switch.js";
// Local client account switching
export {
  CLIENT_SWITCH_INTERRUPTED_REASON,
  clientRuntimeMarkerPath,
  clientSwitchJournalPath,
  clientSwitchLockPath,
  confirmLocalClientSwitch,
  ensureActiveRootClientIdPersisted,
  getClientSwitchStartupBlock,
  hasIncompleteClientSwitch,
  listLiveClientRuntimeMarkers,
  readActiveClientIdFromIndex,
  readActiveClientOwner,
  readActiveRootClientId,
  readRememberedLocalClientIdForAccount,
  recordActiveClientOwner,
  registerClientRuntimeMarker,
  resolveClientRuntimeStopReason,
  stopClientRuntimeProcess,
  switchLocalClientForLogin,
} from "./client-switch.js";
export type {
  ContextReviewConfigReader,
  ContextReviewConfigResult,
  MemberContextReviewConfigReader,
} from "./context-review-config.js";
export {
  normalizeContextReviewConfig,
  readContextReviewConfig,
  readMemberContextReviewConfig,
} from "./context-review-config.js";
export type {
  ContextTreeBindingResult,
  ContextTreeConfigReader,
  ContextTreeReadLogger,
  ContextTreeUnreadableCategory,
  ReadContextTreeBindingOptions,
} from "./context-tree-binding.js";
export {
  ContextTreeUnreadableError,
  classifyContextTreeReadError,
  normalizeContextTreeBinding,
  readAgentContextTreeBinding,
} from "./context-tree-binding.js";
export type {
  ContextTreeBindingInput,
  ContextTreeConfigWriter,
  ContextTreeUpdateFailedCategory,
  SetContextTreeBindingOptions,
} from "./context-tree-binding-write.js";
export {
  ContextTreeUpdateFailedError,
  classifyContextTreeUpdateError,
  InvalidContextTreeBindingInputError,
  setAgentContextTreeBinding,
  validateContextTreeBindingInput,
} from "./context-tree-binding-write.js";
export type {
  ActivateContextTreeReadInput,
  ContextTreeReadActivation,
  ContextTreeReadActivationErrorCode,
  ContextTreeReadAuthorityReader,
  ContextTreeReadGitRunner,
  ContextTreeReadSnapshotIdentity,
  ContextTreeReadStage,
} from "./context-tree-read.js";
export {
  activateContextTreeRead,
  ContextTreeReadActivationError,
  InvalidContextTreeReadSnapshotError,
  readContextTreeReadSnapshotIdentity,
} from "./context-tree-read.js";
export type {
  ContextTreeSeedAuthorityReader,
  ContextTreeSeedPreflight,
  ContextTreeSeedPreflightCliErrorCode,
  ContextTreeSeedStage,
  PreflightContextTreeSeedInput,
} from "./context-tree-seed.js";
export { ContextTreeSeedPreflightCliError, preflightContextTreeSeed } from "./context-tree-seed.js";
export type {
  ContextTreeWriteAuthorityReader,
  ContextTreeWritePreflight,
  ContextTreeWritePreflightCliErrorCode,
  ContextTreeWriteStage,
  PreflightContextTreeWriteInput,
} from "./context-tree-write.js";
export { ContextTreeWritePreflightCliError, preflightContextTreeWrite } from "./context-tree-write.js";
// User-owned daemon environment (proxy etc.) — read, never written by us
export { daemonEnvPath, loadDaemonEnv, parseDaemonEnv } from "./daemon-env.js";
// Document review (docloop) CLI helpers
export { slugFromFilename, titleFromMarkdown } from "./doc-review.js";
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
  runtimeProviderCheck,
  runtimeProviderChecks,
} from "./doctor.js";
export type { InstallClaudeResult } from "./install-claude-runtime.js";
export { installClaudeRuntime } from "./install-claude-runtime.js";
export type { InstallCodexResult } from "./install-codex-runtime.js";
export { installCodexRuntime } from "./install-codex-runtime.js";
// One-shot retirement of the pre-#775 legacy github-scan launchd runner
// (issue #995) — bootout + plist cleanup on first run of a new version.
export type { LegacyGithubScanRetireResult } from "./legacy-github-scan.js";
export { retireLegacyGithubScanRunner } from "./legacy-github-scan.js";
export {
  type MemberOrganizationProfile,
  type MemberOrganizationResolutionCode,
  MemberOrganizationResolutionError,
  resolveMemberOrganizationId,
} from "./member-org.js";
export {
  dispatchMemberReviewTask,
  type MemberReviewTaskClient,
  MemberReviewTaskInputError,
  type MemberReviewTaskInputErrorCode,
  readMemberReviewTaskMetadata,
} from "./member-review-task.js";
// Phase 3 of the agent-naming refactor — renames local agent dirs whose
// name drifted from the server-authoritative `agent.name` slug.
export type { AgentDirMigrationLog, AgentDirMigrationResult, NameResolver } from "./migrate-agent-dirs.js";
export { createApiNameResolver, migrateLocalAgentDirs } from "./migrate-agent-dirs.js";
// Workspace migration to W1
export type {
  MigrateOptions,
  MigrationArtifactKind,
  MigrationDetection,
  MigrationResult,
  PromoteOptions,
  PromoteResult,
} from "./migrate-workspace.js";
export {
  detectMigrationState,
  migrateWorkspaceToW1,
  planPromotableDryRun,
  promoteToWorkspace,
} from "./migrate-workspace.js";
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
// Runtime-auth login orchestrator (browser-OAuth provider login)
export { type RuntimeAuthLoginDeps, runRuntimeAuthLogin } from "./runtime-auth-login.js";
export type { PinnedAgentRuntimeRecord } from "./runtime-provider-reconcile.js";
// Pre-flight runtime-provider reconciliation (P2 — capabilities + YAML rewrite)
export {
  listPinnedAgents,
  reconcileLocalRuntimeProviders,
  uploadAgentSkills,
  uploadClientCapabilities,
} from "./runtime-provider-reconcile.js";
// Background service install (launchd / systemd)
export type { ServiceInfo, ServiceOpResult, ServiceState } from "./service-install.js";
export {
  getClientServiceStatus,
  installClientService,
  isServiceSupported,
  isServiceUnitDriftDetected,
  refreshClientServiceUnitForUpdate,
  resolveCliInvocation,
  restartClientService,
  startClientService,
  stopClientService,
  uninstallClientService,
} from "./service-install.js";
export type { ExecuteUpdateResult, InstallMode, VersionLookupResult } from "./update.js";
// Self-update glue — exported so both `client start` and `login <code>`
// can pass identical prompt / install callbacks to the ClientRuntime.
export {
  detectInstallMode,
  fetchLatestVersion,
  fetchPortableLatestVersion,
  fetchServerCommandVersion,
  installGlobalLatest,
  installGlobalSpec,
  installPortableSpec,
  PACKAGE_NAME,
} from "./update.js";
export {
  createExecuteUpdate,
  declineUpdate,
  promptUpdate,
  refreshServerUpdateTarget,
  SELF_RESTART_EXIT_CODE,
} from "./update-glue.js";
export {
  defaultUpdateStatePath,
  isLoopGuarded,
  readUpdateState,
  recordUpdateAttempt,
  type UpdateAttempt,
  type UpdateState,
} from "./update-state.js";
// Command package version (bundle self-identification)
export { CLI_USER_AGENT, COMMAND_VERSION } from "./version.js";
// Workspace-rooted layout (workspace-layout-simplification.md)
export type { WorkspaceBoundSource, WorkspaceStatus, WorkspaceUnboundSibling } from "./workspace.js";
export {
  computeWorkspaceStatus,
  discoverWorkspaceRoot,
  pickImmediateWorkspaceSources,
  readGitRemoteUrl,
  readWorkspaceManifest,
  writeWorkspaceManifest,
} from "./workspace.js";
