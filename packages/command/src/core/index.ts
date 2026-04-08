// Server lifecycle

// Admin management
export { createAdminUser, hasAdminUser } from "./admin.js";
// Bootstrap
export {
  bootstrapToken,
  checkBootstrapStatus,
  getGitHubToken,
  getGitHubUsername,
  resolveAgentToken,
  resolveServerUrl,
} from "./bootstrap.js";
// Client runtime
export { ClientRuntime } from "./client-runtime.js";
// Docker PostgreSQL
export { ensurePostgres, isDockerAvailable, stopPostgres } from "./docker-postgres.js";
// Diagnostics (doctor)
export type { CheckResult } from "./doctor.js";
export {
  checkAgentConfigs,
  checkAgentTokens,
  checkClientConfig,
  checkContextTreeRepo,
  checkDatabase,
  checkDocker,
  checkGitHubToken,
  checkNodeVersion,
  checkServerConfig,
  checkServerHealth,
  checkServerReachable,
  checkWebSocket,
  printResults,
} from "./doctor.js";
// Feishu
export { bindFeishuBot, bindFeishuUser } from "./feishu.js";
// Database
export { runMigrations } from "./migrate.js";
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
export type { StartOptions } from "./server.js";
export { startServer } from "./server.js";
