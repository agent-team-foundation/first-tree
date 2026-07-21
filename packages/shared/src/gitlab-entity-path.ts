export type GitlabEntityPath = {
  entityType: "issue" | "pull_request";
  entityIid: number;
  projectPath: string;
};

export type GitlabEntityPathParseResult =
  | { ok: true; value: GitlabEntityPath }
  | { ok: false; reason: "route" | "encoding" | "control_character" | "identity" };

const ROUTE_SUFFIXES = [
  { suffix: "/-/merge_requests", entityType: "pull_request" },
  { suffix: "/merge_requests", entityType: "pull_request" },
  { suffix: "/-/issues", entityType: "issue" },
  { suffix: "/issues", entityType: "issue" },
] as const;

/**
 * Parse the pathname portion of a GitLab issue or merge-request URL.
 *
 * GitLab emits both the canonical `project/-/…` routes and legacy
 * `project/…` routes. Keeping this parser browser-safe gives the server and
 * chat renderer one definition of those route shapes.
 */
export function parseGitlabEntityPath(pathname: string): GitlabEntityPathParseResult {
  let path = pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);

  const iidSeparator = path.lastIndexOf("/");
  if (iidSeparator <= 0) return { ok: false, reason: "route" };

  const rawIid = path.slice(iidSeparator + 1);
  if (!isAsciiDigits(rawIid)) return { ok: false, reason: "route" };

  const route = path.slice(0, iidSeparator);
  const routeSuffix = ROUTE_SUFFIXES.find(({ suffix }) => route.endsWith(suffix));
  if (!routeSuffix) return { ok: false, reason: "route" };

  const encodedProjectPath = route.slice(1, -routeSuffix.suffix.length);
  if (!path.startsWith("/") || !encodedProjectPath) return { ok: false, reason: "route" };

  let projectPath: string;
  try {
    projectPath = decodeURIComponent(encodedProjectPath);
  } catch {
    return { ok: false, reason: "encoding" };
  }
  if (/\p{Cc}/u.test(projectPath)) return { ok: false, reason: "control_character" };

  const entityIid = Number(rawIid);
  if (!projectPath || !Number.isSafeInteger(entityIid) || entityIid <= 0) {
    return { ok: false, reason: "identity" };
  }

  return {
    ok: true,
    value: {
      entityType: routeSuffix.entityType,
      entityIid,
      projectPath,
    },
  };
}

function isAsciiDigits(value: string): boolean {
  if (!value) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}
