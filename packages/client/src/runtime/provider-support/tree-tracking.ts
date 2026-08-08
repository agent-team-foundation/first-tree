/**
 * Provider-support tree-tracking group.
 *
 * Runtime owns Context Tree path attribution and git write-status tracking that
 * adapters attach to tool/file refs. Does not own Context Tree rebind or
 * workspace binding policy.
 */

export type { ContextTreeAttribution, ShellCommandFileRefsInput } from "../context-tree-file-refs.js";
export {
  canonicalizeFsPath,
  contextTreeRelativePathOf,
  resolveContextTreeRelativePath,
  toolFileRefsFromShellCommand,
  withContextTreeRepoHeadCommit,
} from "../context-tree-file-refs.js";

export type { ContextTreeGitWriteTracker } from "../context-tree-git-status.js";
export { createContextTreeGitWriteTracker } from "../context-tree-git-status.js";
