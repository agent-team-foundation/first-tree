/**
 * Provider-support host-runtime group.
 *
 * Cross-cutting Runtime-owned host helpers that adapters and transitional
 * provider-family modules need: briefing rewrite, CLI binding, agent-home path
 * helpers, binary-discovery path roots, and workspace file locking.
 * Concrete provider binary / login / capability modules are not re-exported.
 */

export type { AgentConfigCache } from "../agent-config-cache.js";
export type { PredeclaredSourceRepo } from "../bootstrap.js";
export { FIRST_TREE_WORKSPACE_MARKER, writeAgentBriefing } from "../bootstrap.js";

export { getCliBinding } from "../cli-binding.js";

export { resolveGitRepoTargetPath } from "../git-local-path.js";

export type { ActiveVersionManager, ReadDirNames, VersionManagerDirDeps } from "../install-locations.js";
export { codexDesktopAppBinDirs, versionManagerBinDirs, wellKnownBinDirs } from "../install-locations.js";

export type { RunShell } from "../login-shell-path.js";
export { buildProbeScript, getLoginShellPathDirs, resetLoginShellPathDirsCache } from "../login-shell-path.js";

export type { ReadLink } from "../protected-paths.js";
export {
  automaticCandidateAllowed,
  protectedRootsOnThisHost,
  resolveOutsideProtectedRoots,
  resolveOutsideProtectedRootsOnThisHost,
} from "../protected-paths.js";

export type { AcquireWorkspaceFileLockOptions, WorkspaceFileLock } from "../workspace-file-lock.js";
export { acquireWorkspaceFileLock, WorkspaceFileLockTimeoutError } from "../workspace-file-lock.js";
