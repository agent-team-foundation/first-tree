export type {
  BoundAgent,
  ClientConnectionConfig,
  ProviderModelsListCommand,
  RuntimeAuthCommand,
  ServerWelcome,
  SessionCommand,
} from "./client-connection.js";
export {
  ClientConnection,
  ClientOrgMismatchError,
  ClientRetiredError,
  ClientUserMismatchError,
} from "./client-connection.js";
// Handlers
export { detectStreamApiError, StreamApiTransientError } from "./handlers/claude-code.js";
export { createKimiCodeHandler, formatKimiCodeError, kimiToolIsReadOnly } from "./handlers/kimi-code.js";
export {
  buildOpenCodeConfigContent,
  buildOpenCodeTurnArgs,
  createOpenCodeHandler,
  mapOpenCodeMcpServers,
} from "./handlers/opencode/index.js";
export {
  applyClientLoggerConfig,
  captureClientException,
  configureClientLoggerForService,
  createLogger,
  flushClientSentry,
  initClientSentry,
  rootLogger,
} from "./observability/index.js";
export type {
  RuntimeAuthDriver,
  RuntimeAuthLoginResolution,
  RuntimeAuthLoginStart,
  RuntimeAuthProbeResult,
} from "./providers/auth-driver.js";
export type { RuntimeAuthDriverTable } from "./providers/auth-drivers.js";
export { RUNTIME_AUTH_DRIVERS } from "./providers/auth-drivers.js";
export type { BuiltinProviderProbeTable, CapabilityProbe } from "./providers/builtin-probes.js";
export { BUILTIN_PROVIDER_PROBES, probedRuntimeProviders } from "./providers/builtin-probes.js";
export type { BuiltinHandlerRegistry, BuiltinHandlerRegistryDeps } from "./providers/builtin-registry.js";
export {
  createBuiltinHandlerRegistry,
  resolveAndLogClaudeExecutable,
} from "./providers/builtin-registry.js";
export {
  type DiscoverModelsDeps,
  discoverProviderModels,
  parseCursorModelsOutput,
  parseKimiConfigModels,
} from "./providers/discover-models.js";
export {
  findGrokExecutableOnPath,
  formatGrokBinaryMissingMessage,
  GROK_INSTALL_COMMAND,
  type GrokRuntimeBinaryResolution,
  resolveGrokRuntimeBinary,
} from "./providers/grok/binary.js";
export { probeGrokCapability } from "./providers/grok/capability.js";
export {
  createGrokAuthDriver,
  type GrokAuthDriverDeps,
  type GrokBrowserLoginOptions,
  runGrokBrowserLogin,
} from "./providers/grok/login.js";
// Runtime-auth (browser OAuth)
export {
  AUTH_URL_TOKEN_MAX,
  type AuthUrlScanner,
  BROWSER_LOGIN_TIMEOUT_MS,
  createAuthUrlScanner,
  extractAuthUrl,
  LOGIN_STDERR_TAIL_MAX,
  type LoginOutcome,
  stripAnsi,
} from "./providers/runtime-login.js";
export { PROVIDER_SKILL_ROOTS } from "./providers/skill-roots.js";
export { readCanonicalContextTreeWriteRouting } from "./runtime/agent-briefing.js";
// Runtime
export type { AgentSlotConfig } from "./runtime/agent-slot.js";
export { AgentSlot } from "./runtime/agent-slot.js";
export type { ContextTreeBinding } from "./runtime/bootstrap.js";
export {
  ensureWorkspaceRuntimeDir,
  migrateLegacyRuntimeLayout,
  resolveAgentContextTreeBinding,
} from "./runtime/bootstrap.js";
// Capabilities
export { probeClaudeCodeCapability } from "./runtime/capabilities/claude-code.js";
export { probeClaudeCodeTuiCapability } from "./runtime/capabilities/claude-code-tui.js";
export {
  type CodexBinaryResolution,
  probeCodexCapability,
  resolveCodexRuntimeBinary,
} from "./runtime/capabilities/codex.js";
export { probeCursorCapability } from "./runtime/capabilities/cursor.js";
export {
  CAPABILITY_REFRESH_BASE_MS,
  CAPABILITY_REFRESH_MAX_MS,
  hasNonOkProvider,
  nextCapabilityRefreshDelayMs,
  PROBED_RUNTIME_PROVIDERS,
  probeCapabilities,
  REPROBE_MAX_AGE_MS,
  reprobeOnReconnect,
  revalidateCapabilities,
  shouldFullReprobe,
} from "./runtime/capabilities/index.js";
export { probeOpenCodeCapability } from "./runtime/capabilities/opencode.js";
export { probePiCapability } from "./runtime/capabilities/pi.js";
export type {
  AdoptOptions,
  ChildCategory,
  ChildProcessRegistry,
  CleanupPolicy,
  RegisteredChild,
  RegistrySpawnOptions,
} from "./runtime/child-process-registry.js";
export { CHILD_CATEGORIES, getChildProcessRegistry } from "./runtime/child-process-registry.js";
export {
  type ClaudeAuthDriverDeps,
  type ClaudeBrowserLoginOptions,
  type ClaudeLoginInvocation,
  createClaudeAuthDriver,
  resolveClaudeLoginInvocation,
  runClaudeBrowserLogin,
} from "./runtime/claude-login.js";
export type { CliBinding } from "./runtime/cli-binding.js";
export { setCliBinding } from "./runtime/cli-binding.js";
export {
  type CodexAuthDriverDeps,
  type CodexBrowserLoginOptions,
  createCodexAuthDriver,
  runCodexBrowserLogin,
} from "./runtime/codex-login.js";
export type { AgentSlotYamlConfig, RuntimeConfig, SessionConfig } from "./runtime/config.js";
export { loadRuntimeConfig } from "./runtime/config.js";
export {
  CURSOR_INSTALL_COMMAND,
  type CursorRuntimeBinaryResolution,
  findCursorExecutableOnPath,
  formatCursorBinaryMissingMessage,
  resolveCursorRuntimeBinary,
} from "./runtime/cursor-binary.js";
export {
  type CursorAuthDriverDeps,
  type CursorBrowserLoginOptions,
  createCursorAuthDriver,
  runCursorBrowserLogin,
} from "./runtime/cursor-login.js";
export { Deduplicator } from "./runtime/deduplicator.js";
export type { AttachmentUploader, SelfFence, WorkspaceFence } from "./runtime/doc-snapshots.js";
export { buildMessageDocumentSnapshots } from "./runtime/doc-snapshots.js";
export type { Classification, ErrorKind, ErrorSource, RetryStrategy } from "./runtime/error-taxonomy.js";
export { clampRetryAttempt, classify, ERROR_KINDS, nextRetryDelayMs } from "./runtime/error-taxonomy.js";
export type {
  AgentHandler,
  HandlerConfig,
  HandlerContext,
  HandlerFactory,
  HandlerFactoryMap,
  SessionContext,
  SessionMessage,
} from "./runtime/handler.js";
export type { BuildImageAttachmentsOptions, BuildMessageImageSnapshotsResult } from "./runtime/image-snapshots.js";
export { buildMessageImageSnapshots } from "./runtime/image-snapshots.js";
export { InputController } from "./runtime/input-controller.js";
export {
  findOpenCodeExecutableOnPath,
  formatOpenCodeBinaryMissingMessage,
  isSupportedOpenCodeVersion,
  OPENCODE_INSTALL_COMMAND,
  OPENCODE_LOGIN_COMMAND,
  OPENCODE_MINIMUM_VERSION,
  OPENCODE_SUPPORTED_VERSION_RANGE,
  parseOpenCodeVersionOutput,
  resolveOpenCodeRuntimeBinary,
} from "./runtime/opencode-binary.js";
export {
  findPiExecutableOnPath,
  formatPiBinaryMissingMessage,
  isSupportedPiVersion,
  PI_INSTALL_COMMAND,
  PI_LOGIN_COMMAND,
  PI_MINIMUM_VERSION,
  PI_SUPPORTED_VERSION_RANGE,
  parsePiVersionOutput,
  resolvePiRuntimeBinary,
} from "./runtime/pi-binary.js";
export {
  createDefaultProviderProcessSupervisor,
  type ProviderProcessSpec,
  ProviderProcessSupervisionUnsupportedError,
  type ProviderProcessSupervisor,
  type SupervisedProviderProcess,
} from "./runtime/provider-process-supervisor.js";
export { redactErrorPreview } from "./runtime/redact-error-preview.js";
export type { AgentRuntimeOptions } from "./runtime/runtime.js";
export { AgentRuntime } from "./runtime/runtime.js";
// Skills (slash-command discovery)
export { discoverClaudeCodeSkills } from "./runtime/skills/index.js";
export type {
  ExecuteUpdateFn,
  ExecuteUpdateResult,
  QuietGateSnapshot,
  RefreshUpdateTargetFn,
  RefreshUpdateTargetResult,
  UpdateHooks,
  UpdateLogger,
  UpdateLogLevel,
  UpdateManagerOptions,
  UpdatePromptFn,
} from "./runtime/update-manager.js";
export { UpdateManager } from "./runtime/update-manager.js";
export {
  acquireAgentHome,
  acquireWorkspace,
  cleanWorkspaces,
  clearWorkspaceInitComplete,
  DEFAULT_WORKSPACE_TTL_MS,
  INIT_COMPLETE_SENTINEL_REL,
  markWorkspaceInitComplete,
} from "./runtime/workspace.js";
export type {
  CleanAgentWorkspacesOptions,
  CleanAgentWorkspacesResult,
  CleanedWorkspaceEntry,
} from "./runtime/workspace-maintenance.js";
export { cleanAgentWorkspaces } from "./runtime/workspace-maintenance.js";
export type {
  AccessTokenProvider,
  ContextReviewRuntimeConfig,
  ContextTreeConfig,
  MemberProfile,
  PaginatedResult,
  RegisterResult,
  SdkConfig,
} from "./sdk.js";
export { FirstTreeHubSDK, FirstTreeHubSDK as FirstTreeSDK, SdkError } from "./sdk.js";
