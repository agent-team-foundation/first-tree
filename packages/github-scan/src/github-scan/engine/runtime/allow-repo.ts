import { RepoFilter } from "./repo-filter.js";

export const REQUIRED_ALLOW_REPO_USAGE =
  "--allow-repo <owner/repo[,owner/*,...]>";

export const REQUIRED_ALLOW_REPO_MESSAGE =
  "missing required --allow-repo <owner/repo[,owner/*,...]>; first-tree github scan startup now requires an explicit repo scope to avoid scanning all notifications";

export function parseAllowRepoArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--allow-repo") return argv[i + 1];
    if (arg?.startsWith("--allow-repo=")) {
      return arg.slice("--allow-repo=".length);
    }
  }
  return undefined;
}

export function requireExplicitRepoFilter(
  allowRepo: string | undefined,
): RepoFilter {
  const trimmed = allowRepo?.trim();
  if (!trimmed) {
    throw new Error(REQUIRED_ALLOW_REPO_MESSAGE);
  }
  const filter = RepoFilter.parseCsv(trimmed);
  if (filter.isEmpty()) {
    throw new Error(REQUIRED_ALLOW_REPO_MESSAGE);
  }
  return filter;
}
