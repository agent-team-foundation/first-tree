import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { SdkError } from "@first-tree/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activateContextTreeRead, type ContextTreeReadGitRunner } from "../core/context-tree-read.js";
import { type ContextTreeWriteAuthorityReader, preflightContextTreeWrite } from "../core/context-tree-write.js";

type RemoteFixture = {
  bindingRepo: string;
  origin: string;
  seed: string;
};

const cleanupRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function writeNode(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\ntitle: "Context Tree"\nowners: [owner]\n---\n\n${body}\n`);
}

function createRemote(root: string): RemoteFixture {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const bindingRepo = "https://github.com/acme/context-tree.git";
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
  git(seed, "config", "user.email", "agent@example.com");
  git(seed, "config", "user.name", "Agent");
  writeNode(join(seed, "NODE.md"), "Current decisions.");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "seed tree");
  git(seed, "push", "origin", "main");
  return { bindingRepo, origin, seed };
}

function createRunner(
  remote: RemoteFixture,
  events: string[][],
  aliases: string[] = [remote.bindingRepo],
): ContextTreeReadGitRunner {
  return (cwd, args) => {
    events.push([...args]);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: String(aliases.length),
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const [index, alias] of aliases.entries()) {
      env[`GIT_CONFIG_KEY_${index}`] = `url.${pathToFileURL(remote.origin).href}.insteadOf`;
      env[`GIT_CONFIG_VALUE_${index}`] = alias;
    }
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
}

async function activateSnapshot(
  root: string,
  remote: RemoteFixture,
  runGit: ContextTreeReadGitRunner,
  teamId = "team-a",
  bindingRepo = remote.bindingRepo,
): Promise<string> {
  const snapshotPath = join(root, "snapshot");
  await activateContextTreeRead(
    {
      getMemberContextTreeSetting: async () => ({ repo: bindingRepo, branch: "main" }),
    },
    { teamId, snapshotPath },
    runGit,
  );
  return snapshotPath;
}

function authorityReader(
  response: Record<string, unknown> | Error | ((teamId: string) => Record<string, unknown> | Error),
): { reader: ContextTreeWriteAuthorityReader; preflight: ReturnType<typeof vi.fn> } {
  const preflight = vi.fn(async (teamId: string) => {
    const value = typeof response === "function" ? response(teamId) : response;
    if (value instanceof Error) throw value;
    return value;
  });
  return { reader: { preflightMemberContextTreeWrite: preflight }, preflight };
}

function currentAuthority(remote: RemoteFixture, overrides: Record<string, unknown> = {}) {
  return {
    organizationId: "team-a",
    provider: "github",
    binding: { repo: remote.bindingRepo, branch: "main" },
    gitlabInstanceOrigin: null,
    reviewerAgentUuid: "reviewer-a",
    requesterGithubLogin: "writer",
    ...overrides,
  };
}

describe("clean BYO Context Tree Write preflight", () => {
  it("succeeds in a new process-shaped directory without a Workspace manifest", async () => {
    const root = tempRoot("ft-byo-write-success-");
    const remote = createRemote(root);
    const sshBinding = "ssh://git@github.com/acme/context-tree.git";
    const events: string[][] = [];
    const runGit = createRunner(remote, events, [remote.bindingRepo, sshBinding]);
    const snapshotPath = await activateSnapshot(root, remote, runGit);
    const cleanInvocation = join(root, "clean-invocation");
    mkdirSync(cleanInvocation);
    process.chdir(cleanInvocation);
    expect(existsSync(join(cleanInvocation, ".first-tree", "workspace.json"))).toBe(false);
    const { reader, preflight } = authorityReader(
      currentAuthority(remote, { binding: { repo: sshBinding, branch: "main" } }),
    );

    const result = await preflightContextTreeWrite(
      reader,
      { teamId: "team-a", snapshotPath, requesterGithubLogin: "writer" },
      runGit,
    );

    expect(result).toEqual({
      provider: "github",
      teamId: "team-a",
      binding: { repo: sshBinding, branch: "main" },
      baseCommit: git(remote.seed, "rev-parse", "HEAD"),
      snapshotPath: realpathSync(snapshotPath),
      reviewerAgentUuid: "reviewer-a",
      requesterGithubLogin: "writer",
      gitlabInstanceOrigin: null,
    });
    expect(preflight).toHaveBeenCalledWith("team-a", { requesterGithubLogin: "writer" }, { retry: false });
    expect(events.filter((args) => args[0] === "fetch")).toHaveLength(2);
    expect(events.some((args) => args[0] === "push" || args[0] === "pull" || args[0] === "clone")).toBe(false);
  });

  it("is stateless across keyed repeats and observes the latest Server Reviewer", async () => {
    const root = tempRoot("ft-byo-write-repeat-");
    const remote = createRemote(root);
    const events: string[][] = [];
    const runGit = createRunner(remote, events);
    const snapshotPath = await activateSnapshot(root, remote, runGit);
    let call = 0;
    const { reader, preflight } = authorityReader(() =>
      currentAuthority(remote, { reviewerAgentUuid: call++ === 0 ? "reviewer-a" : "reviewer-b" }),
    );
    const input = { teamId: "team-a", snapshotPath, requesterGithubLogin: "writer" };

    const first = await preflightContextTreeWrite(reader, input, runGit);
    process.chdir(tempRoot("ft-byo-write-new-process-"));
    const second = await preflightContextTreeWrite(reader, input, runGit);

    expect(first.reviewerAgentUuid).toBe("reviewer-a");
    expect(second.reviewerAgentUuid).toBe("reviewer-b");
    expect(first.baseCommit).toBe(second.baseCommit);
    expect(preflight).toHaveBeenCalledTimes(2);
  });

  it("rejects a mismatched explicit Team before contacting Server authority", async () => {
    const root = tempRoot("ft-byo-write-team-");
    const remote = createRemote(root);
    const runGit = createRunner(remote, []);
    const snapshotPath = await activateSnapshot(root, remote, runGit, "team-a");
    const { reader, preflight } = authorityReader(currentAuthority(remote));

    await expect(
      preflightContextTreeWrite(reader, { teamId: "team-b", snapshotPath, requesterGithubLogin: "writer" }, runGit),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_WRITE_TEAM_MISMATCH", stage: "snapshot" });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("fails when the live binding differs from the fixed snapshot", async () => {
    const root = tempRoot("ft-byo-write-binding-");
    const remote = createRemote(root);
    const runGit = createRunner(remote, []);
    const snapshotPath = await activateSnapshot(root, remote, runGit);
    const { reader } = authorityReader(
      currentAuthority(remote, { binding: { repo: "https://github.com/acme/other-tree.git", branch: "main" } }),
    );

    await expect(
      preflightContextTreeWrite(reader, { teamId: "team-a", snapshotPath, requesterGithubLogin: "writer" }, runGit),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_WRITE_BINDING_CHANGED", stage: "binding" });
  });

  it("treats a GitLab HTTPS web-port change as a different live binding", async () => {
    const root = tempRoot("ft-byo-write-gitlab-port-");
    const remote = createRemote(root);
    const snapshotRepo = "https://gitlab.internal:8443/acme/context-tree.git";
    const liveRepo = "https://gitlab.internal:9443/acme/context-tree.git";
    const runGit = createRunner(remote, [], [snapshotRepo, liveRepo]);
    const snapshotPath = await activateSnapshot(root, remote, runGit, "team-a", snapshotRepo);
    const { reader } = authorityReader(
      currentAuthority(remote, {
        provider: "gitlab",
        binding: { provider: "gitlab", repo: liveRepo, branch: "main" },
        gitlabInstanceOrigin: "https://gitlab.internal:9443",
        requesterGithubLogin: null,
      }),
    );

    await expect(
      preflightContextTreeWrite(reader, { teamId: "team-a", snapshotPath }, runGit, () => undefined),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_WRITE_BINDING_CHANGED", stage: "binding" });
  });

  it("fails when the bound branch advances beyond the exact snapshot", async () => {
    const root = tempRoot("ft-byo-write-stale-");
    const remote = createRemote(root);
    const runGit = createRunner(remote, []);
    const snapshotPath = await activateSnapshot(root, remote, runGit);
    writeNode(join(remote.seed, "system", "NODE.md"), "New decision.");
    git(remote.seed, "add", ".");
    git(remote.seed, "commit", "-m", "advance tree");
    git(remote.seed, "push", "origin", "main");
    const { reader } = authorityReader(currentAuthority(remote));

    await expect(
      preflightContextTreeWrite(reader, { teamId: "team-a", snapshotPath, requesterGithubLogin: "writer" }, runGit),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_WRITE_SNAPSHOT_STALE", stage: "base" });
  });

  it("fails closed on snapshot tampering before Server or remote work", async () => {
    const root = tempRoot("ft-byo-write-tamper-");
    const remote = createRemote(root);
    const events: string[][] = [];
    const runGit = createRunner(remote, events);
    const snapshotPath = await activateSnapshot(root, remote, runGit);
    writeFileSync(join(snapshotPath, "untracked.md"), "mutable context\n");
    const before = events.length;
    const { reader, preflight } = authorityReader(currentAuthority(remote));

    await expect(
      preflightContextTreeWrite(reader, { teamId: "team-a", snapshotPath, requesterGithubLogin: "writer" }, runGit),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_WRITE_SNAPSHOT_INVALID", stage: "snapshot" });
    expect(preflight).not.toHaveBeenCalled();
    expect(events.slice(before).some((args) => args[0] === "fetch")).toBe(false);
  });

  it("maps transport and identity failures without leaking upstream details", async () => {
    const root = tempRoot("ft-byo-write-authority-");
    const remote = createRemote(root);
    const runGit = createRunner(remote, []);
    const snapshotPath = await activateSnapshot(root, remote, runGit);
    const { reader } = authorityReader(
      new SdkError(403, "private credential=do-not-leak", {
        code: "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH",
      }),
    );

    const error = await preflightContextTreeWrite(
      reader,
      { teamId: "team-a", snapshotPath, requesterGithubLogin: "writer" },
      runGit,
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "CONTEXT_TREE_WRITE_GITHUB_IDENTITY_MISMATCH",
      stage: "authority",
      exitCode: 3,
    });
    expect(String((error as Error).message)).not.toContain("credential");
    expect(String((error as Error).message)).not.toContain("do-not-leak");
  });
});
