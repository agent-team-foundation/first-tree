// Server lifecycle

// Admin management
export { createAdminUser, hasAdminUser } from "./admin.js";
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
// Database
export { runMigrations } from "./migrate.js";
// Output helpers
export { blank, status } from "./output.js";
// Interactive prompts
export { isInteractive, promptAddAgent, promptMissingFields } from "./prompt.js";
export type { StartOptions } from "./server.js";
export { startServer } from "./server.js";
