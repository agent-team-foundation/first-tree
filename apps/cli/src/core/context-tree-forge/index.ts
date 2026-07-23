import { type ContextTreeProvider, canonicalGitRepoIdentity } from "@first-tree/shared";

export type ContextTreeForgeRunner = (
  command: string,
  args: string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
) => string;

export type ContextTreeForgeCoordinate = {
  provider: ContextTreeProvider;
  repoUrl: string;
  host: string;
  path: string;
  webUrl: string;
};

export function resolveContextTreeForgeCoordinate(
  provider: ContextTreeProvider,
  repoUrl: string,
): ContextTreeForgeCoordinate {
  const identity = canonicalGitRepoIdentity(repoUrl);
  if (!identity) throw new Error("--repo must be an exact HTTPS or SSH repository URL.");
  if (provider === "github" && (identity.host !== "github.com" || identity.path.split("/").length !== 2)) {
    throw new Error("GitHub Context Tree repositories must use github.com/<owner>/<repo>.");
  }
  if (provider === "gitlab" && identity.host === "github.com") {
    throw new Error("--provider gitlab cannot be used with a github.com repository.");
  }
  const host = repositoryCliHost(repoUrl, identity.host);
  return {
    provider,
    repoUrl,
    host,
    path: identity.path,
    webUrl: repositoryWebUrl(repoUrl, host, identity.path),
  };
}

export function verifyContextTreeForgeAuth(
  coordinate: ContextTreeForgeCoordinate,
  cwd: string,
  run: ContextTreeForgeRunner,
): void {
  try {
    if (coordinate.provider === "github") {
      run("gh", ["auth", "status", "--hostname", coordinate.host], cwd);
    } else {
      run("glab", ["auth", "status", "--hostname", coordinate.host], cwd);
    }
  } catch {
    const login =
      coordinate.provider === "github"
        ? "`gh auth login --hostname github.com`"
        : `\`glab auth login --hostname ${coordinate.host}\``;
    throw new Error(
      `${coordinate.provider === "github" ? "GitHub" : "GitLab"} CLI is not authenticated for ${coordinate.host}. Run ${login} and retry.`,
    );
  }
}

export function createContextTreeRemote(
  input: {
    coordinate: ContextTreeForgeCoordinate;
    branch: string;
    public: boolean;
    treeRoot: string;
  },
  run: ContextTreeForgeRunner,
): void {
  assertRemoteMissing(input.coordinate, input.treeRoot, run);
  if (input.coordinate.provider === "github") {
    run(
      "gh",
      [
        "repo",
        "create",
        input.coordinate.path,
        input.public ? "--public" : "--private",
        "--source",
        input.treeRoot,
        "--remote",
        "origin",
        "--push",
      ],
      input.treeRoot,
    );
    return;
  }

  run(
    "glab",
    ["repo", "create", input.coordinate.path, input.public ? "--public" : "--private", "--defaultBranch", input.branch],
    input.treeRoot,
    { GITLAB_HOST: input.coordinate.host },
  );
  try {
    run("git", ["remote", "add", "origin", input.coordinate.repoUrl], input.treeRoot);
  } catch {
    run("git", ["remote", "set-url", "origin", input.coordinate.repoUrl], input.treeRoot);
  }
  run("git", ["push", "--set-upstream", "origin", input.branch], input.treeRoot);
}

export function adoptContextTreeRemote(
  input: { coordinate: ContextTreeForgeCoordinate; branch: string; treeRoot: string },
  run: ContextTreeForgeRunner,
): void {
  assertRemoteExists(input.coordinate, input.treeRoot, run);
  const branchRef = `refs/heads/${input.branch}`;
  let remoteHead: string;
  try {
    remoteHead = run(
      "git",
      ["ls-remote", "--exit-code", "--heads", input.coordinate.repoUrl, branchRef],
      input.treeRoot,
    );
  } catch {
    throw new Error(
      `Cannot adopt ${input.coordinate.repoUrl}: branch ${input.branch} is missing or cannot be read with local credentials.`,
    );
  }
  if (!remoteHead.trim()) {
    throw new Error(`Cannot adopt ${input.coordinate.repoUrl}: branch ${input.branch} has no readable head.`);
  }
  run(
    "git",
    ["clone", "--branch", input.branch, "--single-branch", "--", input.coordinate.repoUrl, input.treeRoot],
    process.cwd(),
  );
}

function assertRemoteMissing(coordinate: ContextTreeForgeCoordinate, cwd: string, run: ContextTreeForgeRunner): void {
  try {
    viewRemote(coordinate, cwd, run);
  } catch {
    return;
  }
  throw new Error(`Repository already exists: ${coordinate.webUrl}. Use --adopt instead of --create.`);
}

function assertRemoteExists(coordinate: ContextTreeForgeCoordinate, cwd: string, run: ContextTreeForgeRunner): void {
  try {
    viewRemote(coordinate, cwd, run);
  } catch {
    throw new Error(
      `Repository does not exist or is not readable with local ${coordinate.provider === "github" ? "gh" : "glab"} credentials: ${coordinate.webUrl}.`,
    );
  }
}

function viewRemote(coordinate: ContextTreeForgeCoordinate, cwd: string, run: ContextTreeForgeRunner): void {
  if (coordinate.provider === "github") {
    run("gh", ["repo", "view", coordinate.path, "--json", "nameWithOwner"], cwd);
  } else {
    run("glab", ["repo", "view", coordinate.repoUrl], cwd, { GITLAB_HOST: coordinate.host });
  }
}

function repositoryWebUrl(repoUrl: string, host: string, path: string): string {
  try {
    const url = new URL(repoUrl);
    if (url.protocol === "https:") return `${url.origin}/${path}`;
  } catch {
    // SSH remotes have no canonical browser scheme; GitLab/GitHub web uses HTTPS.
  }
  return `https://${host}/${path}`;
}

function repositoryCliHost(repoUrl: string, fallbackHostname: string): string {
  try {
    const url = new URL(repoUrl);
    if (url.protocol === "https:") {
      return url.port ? `${url.hostname.toLowerCase()}:${url.port}` : url.hostname.toLowerCase();
    }
    if (url.protocol === "ssh:") return url.hostname.toLowerCase();
  } catch {
    // SCP-style remotes do not encode a distinct web/API port.
  }
  return fallbackHostname;
}
