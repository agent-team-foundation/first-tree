import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { SdkError } from "@first-tree/client";
import { contextTreeActiveBindingSchema } from "@first-tree/shared";
import { AuthRefreshFailedError } from "./bootstrap.js";
import { classifyContextTreeReadError } from "./context-tree-binding.js";

export type ContextTreeReadStage = "input" | "authority" | "binding" | "fetch" | "commit" | "snapshot";

export type ContextTreeReadActivationErrorCode =
  | "CONTEXT_TREE_READ_INVALID_INPUT"
  | "CONTEXT_TREE_READ_AUTHORITY_FAILED"
  | "CONTEXT_TREE_READ_BINDING_INVALID"
  | "CONTEXT_TREE_READ_UNBOUND"
  | "CONTEXT_TREE_READ_FETCH_FAILED"
  | "CONTEXT_TREE_READ_COMMIT_FAILED"
  | "CONTEXT_TREE_READ_SNAPSHOT_FAILED";

export type ContextTreeReadAuthorityReader = {
  getMemberContextTreeSetting(teamId: string, options: { retry: false }): Promise<unknown>;
};

export type ContextTreeReadGitRunner = (cwd: string, args: readonly string[]) => string;

export type ActivateContextTreeReadInput = {
  teamId: string;
  snapshotPath: string;
};

export type ContextTreeReadActivation = {
  teamId: string;
  binding: {
    repo: string;
    branch: string;
  };
  commit: string;
  snapshotPath: string;
};

export type ContextTreeReadSnapshotIdentity = ContextTreeReadActivation;

type ContextTreeReadActivationErrorOptions = {
  stage: ContextTreeReadStage;
  exitCode: 1 | 2 | 3 | 6;
  httpStatus?: number;
};

const SNAPSHOT_MARKER_KEY = "first-tree-read.snapshot";
const SNAPSHOT_TEAM_KEY = "first-tree-read.team-id";
const SNAPSHOT_REPO_KEY = "first-tree-read.binding-repo";
const SNAPSHOT_BRANCH_KEY = "first-tree-read.binding-branch";
const SNAPSHOT_COMMIT_KEY = "first-tree-read.commit";
const SNAPSHOT_REF = "refs/first-tree-read/snapshot";
const EXACT_COMMIT_RE = /^[0-9a-f]{40,64}$/u;
const GIT_INDEX_ENTRY_RE = /^([0-7]{6}) [0-9a-f]{40,64} [0-3]\t([\s\S]+)$/u;
const GIT_SYMLINK_MODE = "120000";
const GIT_REGULAR_FILE_MODES = new Set(["100644", "100755"]);

export class ContextTreeReadActivationError extends Error {
  readonly status = "failed";
  readonly stage: ContextTreeReadStage;
  readonly exitCode: 1 | 2 | 3 | 6;
  readonly httpStatus?: number;

  constructor(
    readonly code: ContextTreeReadActivationErrorCode,
    message: string,
    options: ContextTreeReadActivationErrorOptions,
  ) {
    super(message);
    this.name = "ContextTreeReadActivationError";
    this.stage = options.stage;
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
  }
}

export class InvalidContextTreeReadSnapshotError extends Error {
  readonly code = "CONTEXT_TREE_READ_SNAPSHOT_INVALID";

  constructor(message = "The task-scoped Context Tree snapshot is invalid or no longer at its exact commit.") {
    super(message);
    this.name = "InvalidContextTreeReadSnapshotError";
  }
}

/**
 * Perform one task-level BYO Read activation.
 *
 * The explicit Team is checked once through the member-scoped Server API.
 * Only after that succeeds do we perform one strict fetch, resolve an exact
 * commit, and publish a detached snapshot atomically at `snapshotPath`.
 */
export async function activateContextTreeRead(
  reader: ContextTreeReadAuthorityReader,
  input: ActivateContextTreeReadInput,
  runGit: ContextTreeReadGitRunner = runContextTreeReadGit,
): Promise<ContextTreeReadActivation> {
  const teamId = validateTeamId(input.teamId);
  const snapshotPath = validateSnapshotPath(input.snapshotPath);

  if (pathExists(snapshotPath)) {
    throw snapshotFailure(`Snapshot path already exists: ${snapshotPath}`);
  }

  const binding = await readCurrentTeamBinding(reader, teamId);
  const parent = dirname(snapshotPath);
  let stagingPath: string | null = null;
  let published = false;

  try {
    try {
      mkdirSync(parent, { recursive: true });
      stagingPath = mkdtempSync(join(parent, `.${basename(snapshotPath)}.tmp-`));
      runGit(stagingPath, ["init", "--quiet"]);
      runGit(stagingPath, ["remote", "add", "origin", binding.repo]);
    } catch {
      throw snapshotFailure("Could not prepare the task-scoped Context Tree snapshot.");
    }

    try {
      runGit(stagingPath, [
        "fetch",
        "--no-tags",
        "--prune",
        "origin",
        `+refs/heads/${binding.branch}:refs/remotes/origin/${binding.branch}`,
      ]);
    } catch {
      throw new ContextTreeReadActivationError(
        "CONTEXT_TREE_READ_FETCH_FAILED",
        "Strict fetch failed for the selected Team's current Context Tree binding.",
        { stage: "fetch", exitCode: 6 },
      );
    }

    let commit: string;
    try {
      commit = runGit(stagingPath, [
        "rev-parse",
        "--verify",
        `refs/remotes/origin/${binding.branch}^{commit}`,
      ]).toLowerCase();
      if (!EXACT_COMMIT_RE.test(commit)) {
        throw new Error("Git did not return an exact commit id");
      }
    } catch {
      throw new ContextTreeReadActivationError(
        "CONTEXT_TREE_READ_COMMIT_FAILED",
        "The fetched Context Tree branch could not be resolved to an exact commit.",
        { stage: "commit", exitCode: 1 },
      );
    }

    try {
      runGit(stagingPath, ["checkout", "--detach", "--force", commit]);
      const checkedOutCommit = runGit(stagingPath, ["rev-parse", "--verify", "HEAD"]).toLowerCase();
      if (checkedOutCommit !== commit) {
        throw new Error("Checked-out commit did not match the fetched commit");
      }
      assertContextTreeReadSymlinkSafety(stagingPath, runGit);
      if (!statSync(join(stagingPath, "NODE.md")).isFile()) {
        throw new Error("Context Tree root NODE.md is missing");
      }

      runGit(stagingPath, ["config", "--local", SNAPSHOT_MARKER_KEY, "true"]);
      runGit(stagingPath, ["config", "--local", SNAPSHOT_TEAM_KEY, teamId]);
      runGit(stagingPath, ["config", "--local", SNAPSHOT_REPO_KEY, binding.repo]);
      runGit(stagingPath, ["config", "--local", SNAPSHOT_BRANCH_KEY, binding.branch]);
      runGit(stagingPath, ["config", "--local", SNAPSHOT_COMMIT_KEY, commit]);
      runGit(stagingPath, ["update-ref", SNAPSHOT_REF, commit]);

      // The task snapshot has no mutable remote. This makes accidental pull
      // attempts local failures while the hierarchy command also recognizes
      // the marker and skips refresh entirely.
      runGit(stagingPath, ["remote", "remove", "origin"]);
      renameSync(stagingPath, snapshotPath);
      published = true;
      stagingPath = null;

      const identity = readContextTreeReadSnapshotIdentity(snapshotPath, runGit);
      if (identity === null) {
        throw new Error("Published snapshot marker is missing");
      }
      return identity;
    } catch (error) {
      if (error instanceof ContextTreeReadActivationError) {
        throw error;
      }
      throw snapshotFailure("Could not establish a readable exact-commit Context Tree snapshot.");
    }
  } finally {
    if (stagingPath !== null) {
      rmSync(stagingPath, { recursive: true, force: true });
    }
    if (published && !isPublishedSnapshotValid(snapshotPath, runGit)) {
      rmSync(snapshotPath, { recursive: true, force: true });
    }
  }
}

/**
 * Read and verify the local-only identity embedded in an activated snapshot.
 * A normal managed Context Tree checkout has no marker and returns `null`.
 */
export function readContextTreeReadSnapshotIdentity(
  root: string,
  runGit: ContextTreeReadGitRunner = runContextTreeReadGit,
): ContextTreeReadSnapshotIdentity | null {
  let snapshotPath: string;
  try {
    snapshotPath = realpathSync(resolve(root));
  } catch {
    return null;
  }
  let marker: string | null = null;
  let markerCommit: string | null = null;
  try {
    marker = runGit(snapshotPath, ["config", "--local", "--get", SNAPSHOT_MARKER_KEY]);
  } catch {}
  try {
    markerCommit = runGit(snapshotPath, ["rev-parse", "--verify", `${SNAPSHOT_REF}^{commit}`]).toLowerCase();
  } catch {}

  if (marker === null && markerCommit === null) {
    return null;
  }

  if (marker !== "true" || markerCommit === null || !EXACT_COMMIT_RE.test(markerCommit)) {
    throw new InvalidContextTreeReadSnapshotError();
  }

  try {
    const teamId = validateSnapshotTeamId(runGit(snapshotPath, ["config", "--local", "--get", SNAPSHOT_TEAM_KEY]));
    const repo = runGit(snapshotPath, ["config", "--local", "--get", SNAPSHOT_REPO_KEY]);
    const branch = runGit(snapshotPath, ["config", "--local", "--get", SNAPSHOT_BRANCH_KEY]);
    const binding = contextTreeActiveBindingSchema.parse({ repo, branch });
    const commit = runGit(snapshotPath, ["config", "--local", "--get", SNAPSHOT_COMMIT_KEY]).toLowerCase();
    const head = runGit(snapshotPath, ["rev-parse", "--verify", "HEAD"]).toLowerCase();
    // Include ignored files as well as ordinary untracked files. An ignored
    // Markdown file introduced after activation must not become readable as
    // if it were part of the pinned commit.
    const worktreeStatus = runGit(snapshotPath, [
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--ignored=matching",
    ]);

    if (!EXACT_COMMIT_RE.test(commit) || markerCommit !== commit || head !== commit || worktreeStatus !== "") {
      throw new InvalidContextTreeReadSnapshotError();
    }
    assertContextTreeReadSymlinkSafety(snapshotPath, runGit);

    return {
      teamId,
      binding,
      commit,
      snapshotPath,
    };
  } catch (error) {
    if (error instanceof InvalidContextTreeReadSnapshotError) {
      throw error;
    }
    throw new InvalidContextTreeReadSnapshotError();
  }
}

export function runContextTreeReadGit(cwd: string, args: readonly string[]): string {
  const env = { ...process.env };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_WORK_TREE",
  ]) {
    delete env[key];
  }

  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  }).trim();
}

async function readCurrentTeamBinding(
  reader: ContextTreeReadAuthorityReader,
  teamId: string,
): Promise<{ repo: string; branch: string }> {
  let response: unknown;
  try {
    // The activation contract is one live authority request, not merely one
    // SDK method invocation. Force the SDK's transport retry off at the core
    // boundary so direct callers cannot accidentally turn a transient into a
    // second membership/binding check.
    response = await reader.getMemberContextTreeSetting(teamId, { retry: false });
  } catch (error) {
    throw classifyAuthorityFailure(error);
  }

  if (!hasProperty(response, "repo")) {
    throw new ContextTreeReadActivationError(
      "CONTEXT_TREE_READ_UNBOUND",
      "The selected Team does not have a Context Tree binding.",
      { stage: "binding", exitCode: 1 },
    );
  }

  if (!hasStringProperty(response, "repo")) {
    throw bindingInvalidFailure();
  }

  const parsed = contextTreeActiveBindingSchema.safeParse(response);
  if (!parsed.success) {
    throw bindingInvalidFailure();
  }
  return parsed.data;
}

function classifyAuthorityFailure(error: unknown): ContextTreeReadActivationError {
  if (error instanceof SdkError && error.statusCode === 403) {
    return new ContextTreeReadActivationError(
      "CONTEXT_TREE_READ_AUTHORITY_FAILED",
      "The selected Team could not be authorized. Confirm the Team id and active membership, then retry.",
      { stage: "authority", exitCode: 3, httpStatus: 403 },
    );
  }
  if (error instanceof SdkError && error.statusCode === 409) {
    return bindingInvalidFailure(409);
  }

  const classified = classifyContextTreeReadError(error);
  if (classified.category === "invalid-response") {
    return bindingInvalidFailure(classified.httpStatus);
  }

  const isAuthenticationFailure = error instanceof AuthRefreshFailedError || classified.category === "authentication";
  return new ContextTreeReadActivationError(
    "CONTEXT_TREE_READ_AUTHORITY_FAILED",
    isAuthenticationFailure
      ? "Authentication failed before the selected Team could be authorized. Sign in again and retry."
      : "The selected Team's active membership and current Context Tree binding could not be checked online.",
    {
      stage: "authority",
      exitCode: classified.exitCode,
      ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
    },
  );
}

function bindingInvalidFailure(httpStatus?: number): ContextTreeReadActivationError {
  return new ContextTreeReadActivationError(
    "CONTEXT_TREE_READ_BINDING_INVALID",
    "The selected Team's Context Tree binding is invalid and must be repaired before Read activation.",
    {
      stage: "binding",
      exitCode: 1,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    },
  );
}

function snapshotFailure(message: string): ContextTreeReadActivationError {
  return new ContextTreeReadActivationError("CONTEXT_TREE_READ_SNAPSHOT_FAILED", message, {
    stage: "snapshot",
    exitCode: 1,
  });
}

function validateTeamId(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || hasUnsafeTextCharacter(value)) {
    throw new ContextTreeReadActivationError(
      "CONTEXT_TREE_READ_INVALID_INPUT",
      "--team must be an explicit non-empty Team id without padding or control characters.",
      { stage: "input", exitCode: 2 },
    );
  }
  return value;
}

function validateSnapshotTeamId(value: string): string {
  try {
    return validateTeamId(value);
  } catch {
    throw new InvalidContextTreeReadSnapshotError();
  }
}

function validateSnapshotPath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0 || hasUnsafeTextCharacter(value)) {
    throw new ContextTreeReadActivationError(
      "CONTEXT_TREE_READ_INVALID_INPUT",
      "--snapshot must name a non-empty task-owned directory.",
      { stage: "input", exitCode: 2 },
    );
  }
  return resolve(value);
}

function hasUnsafeTextCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return (
      codePoint !== undefined &&
      (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0x2028 || codePoint === 0x2029)
    );
  });
}

function hasStringProperty(value: unknown, property: string): boolean {
  if (!hasProperty(value, property)) {
    return false;
  }
  return typeof Reflect.get(value, property) === "string";
}

function hasProperty(value: unknown, property: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Reflect.has(value, property);
}

function readTrackedContextTreeEntries(root: string, runGit: ContextTreeReadGitRunner): Map<string, string> {
  const entries = new Map<string, string>();
  const output = runGit(root, ["ls-files", "--stage", "-z"]);

  for (const record of output.split("\0")) {
    if (record.length === 0) {
      continue;
    }
    const match = record.match(GIT_INDEX_ENTRY_RE);
    if (match === null) {
      throw new Error("Could not inspect tracked Context Tree entries");
    }
    entries.set(match[2], match[1]);
  }

  return entries;
}

function pathIsInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * A clean Git worktree fixes a symlink blob, not the content at its target.
 * Keep safe in-tree aliases working, but require their final content to be a
 * regular file tracked by the same exact commit. This prevents hierarchy,
 * soft-link, and native Markdown reads from escaping the task snapshot.
 */
function assertContextTreeReadSymlinkSafety(root: string, runGit: ContextTreeReadGitRunner): void {
  const entries = readTrackedContextTreeEntries(root, runGit);
  const canonicalRoot = realpathSync(root);

  for (const [trackedPath, mode] of entries) {
    if (mode !== GIT_SYMLINK_MODE) {
      continue;
    }

    const linkPath = resolve(canonicalRoot, ...trackedPath.split("/"));
    if (!pathIsInside(canonicalRoot, linkPath)) {
      throw new Error("Tracked symbolic link path is outside the snapshot");
    }

    const linkEntry = lstatSync(linkPath);
    if (!linkEntry.isSymbolicLink() || isAbsolute(readlinkSync(linkPath))) {
      throw new Error("Tracked symbolic link is not a safe relative link");
    }

    const canonicalTarget = realpathSync(linkPath);
    if (!pathIsInside(canonicalRoot, canonicalTarget) || !statSync(canonicalTarget).isFile()) {
      throw new Error("Tracked symbolic link target is outside the snapshot or is not a regular file");
    }

    const targetPath = relative(canonicalRoot, canonicalTarget).replace(/\\/gu, "/");
    const targetMode = entries.get(targetPath);
    if (targetMode === undefined || !GIT_REGULAR_FILE_MODES.has(targetMode)) {
      throw new Error("Tracked symbolic link target is not fixed by the snapshot commit");
    }
  }
}

function isPublishedSnapshotValid(path: string, runGit: ContextTreeReadGitRunner): boolean {
  if (!pathExists(path)) {
    return false;
  }
  try {
    return readContextTreeReadSnapshotIdentity(path, runGit) !== null;
  } catch {
    return false;
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
