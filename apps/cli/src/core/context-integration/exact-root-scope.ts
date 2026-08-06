import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTEXT_TREE_SCOPE_MAX_BYTES,
  type ContextTreeActiveBinding,
  parseContextTreeScopeMarkdown,
} from "@first-tree/shared";

const EXACT_COMMIT_RE = /^[0-9a-f]{40,64}$/u;
const ROOT_SCOPE_ENTRY_RE = /^(100644|100755) blob ([0-9a-f]{40,64})\tSCOPE\.md$/u;

export type ContextRootScopeErrorKind = "missing" | "invalid" | "fetch";

export type ExactRootScope = {
  commit: string;
  scope: { schemaVersion: 1; relatedRepositories: string[]; body: string };
};

export class ContextRootScopeError extends Error {
  constructor(
    readonly kind: ContextRootScopeErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ContextRootScopeError";
  }
}

/** Fetch and validate only the exact root SCOPE.md from the binding branch. */
export function fetchExactScope(binding: ContextTreeActiveBinding): ExactRootScope {
  let root: string;
  try {
    root = mkdtempSync(join(tmpdir(), "first-tree-scope-"));
  } catch (error) {
    throw fetchFailure(error);
  }

  try {
    git(root, ["init", "--quiet"]);
    git(root, ["remote", "add", "origin", binding.repo]);
    git(root, ["fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${binding.branch}`]);
    const commit = git(root, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).toLowerCase();
    if (!EXACT_COMMIT_RE.test(commit)) throw fetchFailure();

    const entry = ROOT_SCOPE_ENTRY_RE.exec(git(root, ["ls-tree", commit, "--", "SCOPE.md"]));
    const objectId = entry?.[2];
    if (!objectId) {
      throw new ContextRootScopeError("missing", "Root SCOPE.md is missing or is not a regular file.");
    }

    const size = Number(git(root, ["cat-file", "-s", objectId]));
    if (!Number.isSafeInteger(size) || size < 0) throw fetchFailure();
    if (size > CONTEXT_TREE_SCOPE_MAX_BYTES) {
      throw new ContextRootScopeError(
        "invalid",
        `Root SCOPE.md exceeds the ${CONTEXT_TREE_SCOPE_MAX_BYTES}-byte limit.`,
      );
    }

    const scopeBytes = gitBytes(root, ["cat-file", "blob", objectId], CONTEXT_TREE_SCOPE_MAX_BYTES + 1);
    let markdown: string;
    try {
      markdown = new TextDecoder("utf-8", { fatal: true }).decode(scopeBytes);
    } catch (error) {
      throw new ContextRootScopeError("invalid", "Root SCOPE.md is not valid UTF-8.", { cause: error });
    }

    let parsed: ReturnType<typeof parseContextTreeScopeMarkdown>;
    try {
      parsed = parseContextTreeScopeMarkdown(markdown);
    } catch (error) {
      throw new ContextRootScopeError("invalid", "Root SCOPE.md does not satisfy SCOPE schema version 1.", {
        cause: error,
      });
    }

    return {
      commit,
      scope: {
        schemaVersion: 1,
        relatedRepositories: parsed.frontmatter.relatedRepositories ?? [],
        body: parsed.body,
      },
    };
  } catch (error) {
    if (error instanceof ContextRootScopeError) throw error;
    throw fetchFailure(error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fetchFailure(cause?: unknown): ContextRootScopeError {
  return new ContextRootScopeError(
    "fetch",
    "Could not fetch exact root SCOPE.md from the Context Tree binding.",
    cause === undefined ? undefined : { cause },
  );
}

function git(cwd: string, args: readonly string[], maxBuffer = 1024 * 1024): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
    timeout: 30_000,
  }).trim();
}

function gitBytes(cwd: string, args: readonly string[], maxBuffer: number): Buffer {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer,
    timeout: 30_000,
  });
}
