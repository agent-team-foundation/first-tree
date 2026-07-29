import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type CanonicalResourceRepoKey, canonicalizeResourceRepoUrl, repoUrlSchema } from "@first-tree/shared";
import { loadCredentials } from "../bootstrap.js";
import { channelConfig } from "../channel.js";

export type ContextClientPreflight = {
  checkoutRoot: string;
  repositoryKey: CanonicalResourceRepoKey;
  originUrl: string;
};

export const contextClientPreflightErrorCode = {
  notSignedIn: "not_signed_in",
  notGitCheckout: "not_git_checkout",
  originUnreadable: "origin_unreadable",
  originInvalid: "origin_invalid",
} as const;

export type ContextClientPreflightErrorCode =
  (typeof contextClientPreflightErrorCode)[keyof typeof contextClientPreflightErrorCode];

export class ContextClientPreflightError extends Error {
  constructor(
    readonly code: ContextClientPreflightErrorCode,
    message: string,
    readonly nextAction: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContextClientPreflightError";
  }
}

export function inspectContextClientPreflight(cwd = process.cwd()): ContextClientPreflight {
  if (!loadCredentials()) {
    throw new ContextClientPreflightError(
      contextClientPreflightErrorCode.notSignedIn,
      "First Tree is not signed in.",
      `Run \`${channelConfig.binName} login <code>\`, then rerun this command.`,
    );
  }

  let absoluteCwd: string;
  try {
    absoluteCwd = realpathSync(resolve(cwd));
  } catch (error) {
    throw new ContextClientPreflightError(
      contextClientPreflightErrorCode.notGitCheckout,
      "The current directory is not a readable Git checkout.",
      "Run this command inside the target Git checkout.",
      { cause: error },
    );
  }
  const checkoutRoot = runGit(
    absoluteCwd,
    ["rev-parse", "--show-toplevel"],
    contextClientPreflightErrorCode.notGitCheckout,
  );
  const normalizedCheckoutRoot = realpathSync(checkoutRoot);
  const originUrl = runGit(
    normalizedCheckoutRoot,
    ["remote", "get-url", "origin"],
    contextClientPreflightErrorCode.originUnreadable,
  );
  try {
    repoUrlSchema.parse(originUrl);
  } catch (error) {
    throw new ContextClientPreflightError(
      contextClientPreflightErrorCode.originInvalid,
      "The current Git checkout's `origin` is not a supported repository URL.",
      "Set `origin` to a readable GitHub or GitLab repository URL, then rerun this command.",
      { cause: error },
    );
  }

  return {
    checkoutRoot: normalizedCheckoutRoot,
    repositoryKey: canonicalizeResourceRepoUrl(originUrl),
    originUrl,
  };
}

function runGit(
  cwd: string,
  args: readonly string[],
  code: typeof contextClientPreflightErrorCode.notGitCheckout | typeof contextClientPreflightErrorCode.originUnreadable,
): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).trim();
  } catch (error) {
    throw new ContextClientPreflightError(
      code,
      code === contextClientPreflightErrorCode.originUnreadable
        ? "The current Git checkout has no readable `origin` remote."
        : "The current directory is not a Git checkout.",
      code === contextClientPreflightErrorCode.originUnreadable
        ? "Add or repair `origin` with `git remote add origin <repository-url>` (or `git remote set-url origin <repository-url>`), then rerun this command."
        : "Run this command inside the target Git checkout.",
      { cause: error },
    );
  }
}
