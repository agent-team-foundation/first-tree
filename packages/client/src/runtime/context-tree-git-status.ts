import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { ToolFileRef } from "@first-tree/shared";

const GIT_STATUS_TIMEOUT_MS = 2_000;
const GIT_STATUS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export type ContextTreeGitWriteTracker = {
  captureBaseline(): void;
  refsForSuccessfulToolCall(input: {
    toolName: string;
    toolUseId: string;
    existingRefs?: readonly ToolFileRef[];
  }): ToolFileRef[];
};

type DirtyPath = {
  path: string;
  status: string;
};

type TrackerOptions = {
  contextTreePath: string | null;
  contextTreeRepoUrl: string | null;
  contextTreeBranch?: string | null;
  log?: (message: string) => void;
};

function gitStatus(contextTreePath: string): DirtyPath[] | null {
  try {
    const raw = execFileSync(
      "git",
      ["-C", contextTreePath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      {
        maxBuffer: GIT_STATUS_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: GIT_STATUS_TIMEOUT_MS,
      },
    );
    const entries = raw.toString("utf8").split("\0");
    const paths: DirtyPath[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      const status = entry.slice(0, 2);
      const path = entry.slice(3);
      if (!path) continue;
      paths.push({ path, status });
      if (status[0] === "R" || status[0] === "C") index += 1;
    }
    return paths.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  } catch {
    return null;
  }
}

function pathSet(paths: readonly DirtyPath[]): Set<string> {
  return new Set(paths.map((path) => path.path));
}

export function createContextTreeGitWriteTracker(options: TrackerOptions): ContextTreeGitWriteTracker {
  let baseline: DirtyPath[] | null = null;

  function captureBaseline(): void {
    baseline = options.contextTreePath ? gitStatus(options.contextTreePath) : null;
    if (baseline === null && options.contextTreePath) {
      // Under the agent-managed-repos model the context tree clone may not
      // exist yet at session start — the agent clones it on first use per its
      // briefing protocol. Do not log a "disabled" message here; the lazy
      // re-baseline path below will pick the clone up once it appears.
    }
  }

  captureBaseline();

  return {
    captureBaseline,
    refsForSuccessfulToolCall(input): ToolFileRef[] {
      const contextTreePath = options.contextTreePath;
      const contextTreeRepoUrl = options.contextTreeRepoUrl;
      if (!contextTreePath || !contextTreeRepoUrl) return [];

      // Lazy re-baseline: when the tracker was constructed before the agent
      // cloned the context tree (fresh-bind first turn), the initial
      // captureBaseline() saw no directory and left `baseline = null`.
      // Without recovery every subsequent tool call would short-circuit and
      // the session would silently report no tree writes until either a
      // resume reconstructed the tracker or an explicit captureBaseline()
      // ran. Recover here by treating a freshly-appeared clone as having an
      // empty baseline (the clone was just minted, so anything dirty in it
      // is necessarily this session's work) and continuing to the diff.
      if (baseline === null) {
        const lateBaseline = gitStatus(contextTreePath);
        if (lateBaseline === null) return [];
        baseline = [];
      }

      const current = gitStatus(contextTreePath);
      if (current === null) {
        options.log?.("Context Tree git write tracker skipped: git status check failed");
        baseline = null;
        return [];
      }

      const baselinePaths = pathSet(baseline);
      const existingPaths = new Set(
        (input.existingRefs ?? [])
          .map((ref) => ref.repoRelativePath)
          .filter((path): path is string => typeof path === "string" && path.length > 0),
      );
      const refs = current
        .filter((dirty) => !baselinePaths.has(dirty.path) && !existingPaths.has(dirty.path))
        .map(
          (dirty): ToolFileRef => ({
            origin: "git_status_delta",
            localPath: join(contextTreePath, dirty.path),
            repoUrl: contextTreeRepoUrl,
            ...(options.contextTreeBranch ? { repoBranch: options.contextTreeBranch } : {}),
            repoRelativePath: dirty.path,
            pathKind: "file",
            metadata: {
              gitStatus: dirty.status,
              toolName: input.toolName,
              toolUseId: input.toolUseId,
            },
          }),
        );

      baseline = current;
      return refs;
    },
  };
}
