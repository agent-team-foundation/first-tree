import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SdkError } from "@first-tree/client";
import {
  type ContextTreeWritePreflightErrorCode,
  type ContextTreeWritePreflightRequest,
  canonicalGitRepoUrl,
  contextTreeWritePreflightErrorCodeSchema,
  contextTreeWritePreflightResponseSchema,
} from "@first-tree/shared";
import { AuthRefreshFailedError } from "./bootstrap.js";
import { classifyContextTreeReadError } from "./context-tree-binding.js";
import {
  type ContextTreeReadGitRunner,
  InvalidContextTreeReadSnapshotError,
  readContextTreeReadSnapshotIdentity,
  runContextTreeReadGit,
} from "./context-tree-read.js";

export type ContextTreeWriteStage = "input" | "snapshot" | "authority" | "binding" | "fetch" | "base";

export type ContextTreeWritePreflightCliErrorCode =
  | ContextTreeWritePreflightErrorCode
  | "CONTEXT_TREE_WRITE_INVALID_INPUT"
  | "CONTEXT_TREE_WRITE_SNAPSHOT_INVALID"
  | "CONTEXT_TREE_WRITE_TEAM_MISMATCH"
  | "CONTEXT_TREE_WRITE_PREFLIGHT_INVALID"
  | "CONTEXT_TREE_WRITE_BINDING_CHANGED"
  | "CONTEXT_TREE_WRITE_FETCH_FAILED"
  | "CONTEXT_TREE_WRITE_SNAPSHOT_STALE";

export type ContextTreeWriteAuthorityReader = {
  preflightMemberContextTreeWrite(
    teamId: string,
    request: ContextTreeWritePreflightRequest,
    options: { retry: false },
  ): Promise<unknown>;
};

export type PreflightContextTreeWriteInput = {
  teamId: string;
  snapshotPath: string;
  requesterGithubLogin: string;
};

export type ContextTreeWritePreflight = {
  teamId: string;
  binding: { repo: string; branch: string };
  baseCommit: string;
  snapshotPath: string;
  requesterGithubLogin: string;
};

type ContextTreeWritePreflightErrorOptions = {
  stage: ContextTreeWriteStage;
  exitCode: 1 | 2 | 3 | 6;
  httpStatus?: number;
};

const EXACT_COMMIT_RE = /^[0-9a-f]{40,64}$/u;

export class ContextTreeWritePreflightCliError extends Error {
  readonly status = "failed";
  readonly stage: ContextTreeWriteStage;
  readonly exitCode: 1 | 2 | 3 | 6;
  readonly httpStatus?: number;

  constructor(
    readonly code: ContextTreeWritePreflightCliErrorCode,
    message: string,
    options: ContextTreeWritePreflightErrorOptions,
  ) {
    super(message);
    this.name = "ContextTreeWritePreflightCliError";
    this.stage = options.stage;
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
  }
}

/**
 * Validate a clean BYO writer against one explicit Team and the exact Read
 * snapshot that already supplied task context. This is read-only and leaves
 * no receipt: rerunning it is the safe check immediately before first push.
 */
export async function preflightContextTreeWrite(
  reader: ContextTreeWriteAuthorityReader,
  input: PreflightContextTreeWriteInput,
  runGit: ContextTreeReadGitRunner = runContextTreeReadGit,
): Promise<ContextTreeWritePreflight> {
  const teamId = validateInlineInput(input.teamId, "--team", "Team id");
  const requesterGithubLogin = validateInlineInput(input.requesterGithubLogin, "--github-login", "GitHub login");
  const snapshotPath = validateSnapshotPathInput(input.snapshotPath);
  const snapshot = readSnapshot(snapshotPath, runGit);
  if (snapshot.teamId !== teamId) {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_TEAM_MISMATCH",
      "The exact snapshot was activated for a different Team than --team.",
      { stage: "snapshot", exitCode: 2 },
    );
  }

  let rawAuthority: unknown;
  try {
    rawAuthority = await reader.preflightMemberContextTreeWrite(teamId, { requesterGithubLogin }, { retry: false });
  } catch (error) {
    throw classifyAuthorityFailure(error);
  }

  const parsedAuthority = contextTreeWritePreflightResponseSchema.safeParse(rawAuthority);
  if (!parsedAuthority.success) {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_PREFLIGHT_INVALID",
      "The Server returned an invalid Context Tree Write preflight response.",
      { stage: "authority", exitCode: 1 },
    );
  }
  const authority = parsedAuthority.data;
  if (
    authority.organizationId !== teamId ||
    authority.requesterGithubLogin.toLowerCase() !== requesterGithubLogin.toLowerCase()
  ) {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_PREFLIGHT_INVALID",
      "The Server preflight response does not match the explicit Team and GitHub identity.",
      { stage: "authority", exitCode: 1 },
    );
  }

  if (!sameBinding(snapshot.binding, authority.binding)) {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_BINDING_CHANGED",
      "The selected Team's current Context Tree binding no longer matches the exact task snapshot.",
      { stage: "binding", exitCode: 1 },
    );
  }

  const fetchedCommit = fetchCurrentBindingCommit(authority.binding, runGit);
  if (fetchedCommit !== snapshot.commit) {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_SNAPSHOT_STALE",
      "The selected Team's Context Tree branch advanced after the exact task snapshot was activated.",
      { stage: "base", exitCode: 1 },
    );
  }

  const verifiedSnapshot = readSnapshot(snapshot.snapshotPath, runGit);
  if (
    verifiedSnapshot.teamId !== snapshot.teamId ||
    verifiedSnapshot.commit !== snapshot.commit ||
    verifiedSnapshot.snapshotPath !== snapshot.snapshotPath ||
    !sameBinding(verifiedSnapshot.binding, snapshot.binding)
  ) {
    throw snapshotInvalidFailure();
  }

  return {
    teamId,
    binding: authority.binding,
    baseCommit: snapshot.commit,
    snapshotPath: snapshot.snapshotPath,
    requesterGithubLogin: authority.requesterGithubLogin,
  };
}

function fetchCurrentBindingCommit(
  binding: { repo: string; branch: string },
  runGit: ContextTreeReadGitRunner,
): string {
  let stagingPath: string | null = null;
  try {
    stagingPath = mkdtempSync(join(tmpdir(), "first-tree-write-preflight-"));
    runGit(stagingPath, ["init", "--quiet"]);
    runGit(stagingPath, ["remote", "add", "origin", binding.repo]);
    runGit(stagingPath, [
      "fetch",
      "--no-tags",
      "--prune",
      "origin",
      `+refs/heads/${binding.branch}:refs/remotes/origin/${binding.branch}`,
    ]);
    const commit = runGit(stagingPath, [
      "rev-parse",
      "--verify",
      `refs/remotes/origin/${binding.branch}^{commit}`,
    ]).toLowerCase();
    if (!EXACT_COMMIT_RE.test(commit)) throw new Error("Git did not return an exact commit id");
    return commit;
  } catch {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_FETCH_FAILED",
      "Strict fetch failed for the selected Team's current Context Tree binding.",
      { stage: "fetch", exitCode: 6 },
    );
  } finally {
    if (stagingPath !== null) rmSync(stagingPath, { recursive: true, force: true });
  }
}

function readSnapshot(path: string, runGit: ContextTreeReadGitRunner) {
  try {
    const snapshot = readContextTreeReadSnapshotIdentity(path, runGit);
    if (snapshot === null) throw new InvalidContextTreeReadSnapshotError();
    return snapshot;
  } catch (error) {
    if (error instanceof ContextTreeWritePreflightCliError) throw error;
    throw snapshotInvalidFailure();
  }
}

function classifyAuthorityFailure(error: unknown): ContextTreeWritePreflightCliError {
  if (error instanceof SdkError) {
    const parsedCode = contextTreeWritePreflightErrorCodeSchema.safeParse(error.code);
    if (parsedCode.success) return serverPreflightFailure(parsedCode.data, error.statusCode);
    if (error.statusCode === 401 || error.statusCode === 403) {
      return serverPreflightFailure("CONTEXT_TREE_WRITE_AUTHORITY_FAILED", error.statusCode);
    }
  }

  const classified = classifyContextTreeReadError(error);
  const authentication = error instanceof AuthRefreshFailedError || classified.category === "authentication";
  return new ContextTreeWritePreflightCliError(
    "CONTEXT_TREE_WRITE_AUTHORITY_FAILED",
    authentication
      ? "Authentication failed before the selected Team could authorize Context Tree Write. Sign in again and retry."
      : "The selected Team's current Context Tree Write authority could not be checked online.",
    {
      stage: "authority",
      exitCode: classified.exitCode,
      ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
    },
  );
}

function serverPreflightFailure(
  code: ContextTreeWritePreflightErrorCode,
  httpStatus: number,
): ContextTreeWritePreflightCliError {
  const authorityFailure =
    code === "CONTEXT_TREE_WRITE_AUTHORITY_FAILED" ||
    code === "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_REQUIRED" ||
    code === "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH";
  const messages: Record<ContextTreeWritePreflightErrorCode, string> = {
    CONTEXT_TREE_WRITE_AUTHORITY_FAILED:
      "The selected Team could not authorize Context Tree Write for the signed-in member.",
    CONTEXT_TREE_WRITE_BINDING_UNAVAILABLE: "The selected Team does not have a valid current Context Tree binding.",
    CONTEXT_TREE_WRITE_BINDING_UNSUPPORTED:
      "Managed Agent Review currently requires the selected Team's Context Tree binding to be on GitHub.",
    CONTEXT_TREE_WRITE_CONFIGURATION_INVALID:
      "The selected Team's Context Tree Write configuration is invalid and must be repaired.",
    CONTEXT_TREE_WRITE_GITHUB_IDENTITY_REQUIRED:
      "Connect your GitHub identity to First Tree before starting Context Tree Write.",
    CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH:
      "The local GitHub login does not match the signed-in First Tree member.",
  };
  return new ContextTreeWritePreflightCliError(code, messages[code], {
    stage: authorityFailure ? "authority" : "binding",
    exitCode: authorityFailure ? 3 : 1,
    httpStatus,
  });
}

function sameBinding(left: { repo: string; branch: string }, right: { repo: string; branch: string }): boolean {
  const leftRepo = canonicalGitRepoUrl(left.repo);
  const rightRepo = canonicalGitRepoUrl(right.repo);
  return leftRepo !== null && rightRepo !== null && leftRepo === rightRepo && left.branch === right.branch;
}

function validateInlineInput(value: string, option: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || hasUnsafeTextCharacter(value)) {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_INVALID_INPUT",
      `${option} must be an explicit non-empty ${label} without padding or control characters.`,
      { stage: "input", exitCode: 2 },
    );
  }
  return value;
}

function validateSnapshotPathInput(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || hasUnsafeTextCharacter(value)) {
    throw new ContextTreeWritePreflightCliError(
      "CONTEXT_TREE_WRITE_INVALID_INPUT",
      "--snapshot must name the existing exact task snapshot created by tree read.",
      { stage: "input", exitCode: 2 },
    );
  }
  return value;
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

function snapshotInvalidFailure(): ContextTreeWritePreflightCliError {
  return new ContextTreeWritePreflightCliError(
    "CONTEXT_TREE_WRITE_SNAPSHOT_INVALID",
    "The exact task snapshot is missing, dirty, or no longer fixed at its activated commit.",
    { stage: "snapshot", exitCode: 1 },
  );
}
