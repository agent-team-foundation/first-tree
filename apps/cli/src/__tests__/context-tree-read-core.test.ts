import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { SdkError } from "@first-tree/client";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readContextTreeSnapshot, runTreeTreeCommand } from "../commands/tree/tree.js";
import {
  activateContextTreeRead,
  type ContextTreeReadAuthorityReader,
  type ContextTreeReadGitRunner,
  readContextTreeReadSnapshotIdentity,
} from "../core/context-tree-read.js";
import { setJsonMode } from "../core/output.js";

type RemoteFixture = {
  bindingRepo: string;
  origin: string;
  seed: string;
};

const cleanupRoots: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  vi.restoreAllMocks();
  setJsonMode(false);
  process.chdir(originalCwd);
  for (const root of cleanupRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
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

function writeNode(path: string, title: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\ntitle: "${title}"\nowners: [owner]\n---\n\n# ${title}\n\n${body}\n`);
}

function createRemoteFixture(root: string, name: string, domain: string): RemoteFixture {
  const origin = join(root, `${name}.git`);
  const seed = join(root, `${name}-seed`);
  const bindingRepo = `https://trees.example/${name}.git`;

  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
  git(seed, "config", "user.email", "agent@example.com");
  git(seed, "config", "user.name", "Agent");
  writeNode(join(seed, "NODE.md"), "Context Tree", `${name} root`);
  writeNode(join(seed, domain, "NODE.md"), `${name} ${domain}`, `${domain} decision`);
  writeNode(join(seed, domain, "contract.md"), `${name} contract`, `${name} durable contract`);
  writeFileSync(join(seed, ".gitignore"), "local-only.md\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", `seed ${name}`);
  git(seed, "push", "origin", "main");

  return { bindingRepo, origin, seed };
}

function pushNode(remote: RemoteFixture, relativePath: string, title: string): string {
  writeNode(join(remote.seed, relativePath), title, `${title} body`);
  git(remote.seed, "add", ".");
  git(remote.seed, "commit", "-m", `add ${title}`);
  git(remote.seed, "push", "origin", "main");
  return git(remote.seed, "rev-parse", "HEAD");
}

function pushFixtureChange(remote: RemoteFixture, message: string): string {
  git(remote.seed, "add", "--all");
  git(remote.seed, "commit", "-m", message);
  git(remote.seed, "push", "origin", "main");
  return git(remote.seed, "rev-parse", "HEAD");
}

function createRealGitRunner(
  remotes: RemoteFixture[],
  events: string[][],
  intercept?: (cwd: string, args: readonly string[]) => string | undefined,
): ContextTreeReadGitRunner {
  const rewrites = remotes.map((remote) => [remote.bindingRepo, pathToFileURL(remote.origin).href] as const);

  return (cwd, args) => {
    events.push([...args]);
    const intercepted = intercept?.(cwd, args);
    if (intercepted !== undefined) return intercepted;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_COUNT: String(rewrites.length),
      GIT_TERMINAL_PROMPT: "0",
    };
    for (const [index, [bindingRepo, localRepo]] of rewrites.entries()) {
      env[`GIT_CONFIG_KEY_${index}`] = `url.${localRepo}.insteadOf`;
      env[`GIT_CONFIG_VALUE_${index}`] = bindingRepo;
    }
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
}

function readerFor(bindings: Record<string, { repo?: string; branch?: string } | Error>): {
  reader: ContextTreeReadAuthorityReader;
  read: ReturnType<typeof vi.fn>;
} {
  const read = vi.fn(async (teamId: string, _options: { retry: false }) => {
    const value = bindings[teamId];
    if (value instanceof Error) throw value;
    return (
      value ??
      (() => {
        throw new SdkError(403, "private wrong-team detail");
      })()
    );
  });
  return { reader: { getMemberContextTreeSetting: read }, read };
}

function expectOnlyOneFetch(events: string[][]): void {
  expect(events.filter((args) => args[0] === "fetch")).toHaveLength(1);
  expect(events.every((args) => args[0] !== "pull" && args[0] !== "clone")).toBe(true);
}

describe("task-scoped BYO Context Tree Read activation", () => {
  it.each([
    ["missing Team", "", "/tmp/snapshot"],
    ["padded Team", " team-a", "/tmp/snapshot"],
    ["multiline Team", "team-a\u2028spoof", "/tmp/snapshot"],
    ["multiline snapshot", "team-a", "/tmp/snapshot\nspoof"],
  ])("rejects unsafe explicit input (%s) before authority or Git", async (_label, teamId, snapshotPath) => {
    const events: string[][] = [];
    const { reader, read } = readerFor({
      "team-a": { repo: "https://trees.example/team-a.git", branch: "main" },
    });

    await expect(
      activateContextTreeRead(reader, { teamId, snapshotPath }, (_cwd, args) => {
        events.push([...args]);
        return "";
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_READ_INVALID_INPUT", stage: "input", exitCode: 2 });
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("checks the explicit Team once, fetches once, and reuses one exact snapshot for selectors and files", async () => {
    const root = tempRoot("ft-byo-read-success-");
    const remote = createRemoteFixture(root, "team-a", "security");
    const events: string[][] = [];
    const runGit = createRealGitRunner([remote], events);
    const { reader, read } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });
    const snapshotPath = join(root, "snapshots", "task-a");

    const activation = await activateContextTreeRead(reader, { teamId: "team-a", snapshotPath }, runGit);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith("team-a", { retry: false });
    expectOnlyOneFetch(events);
    expect(activation).toEqual({
      teamId: "team-a",
      binding: { repo: remote.bindingRepo, branch: "main" },
      commit: git(remote.seed, "rev-parse", "HEAD"),
      snapshotPath: realpathSync(snapshotPath),
    });
    expect(() => git(snapshotPath, "remote", "get-url", "origin")).toThrow();

    const beforeReads = events.length;
    expect(readContextTreeSnapshot(snapshotPath, { pattern: "*security*" }).tree.children).toHaveLength(1);
    expect(readContextTreeSnapshot(snapshotPath, { target: "security" }).target).toBe("security");
    expect(readFileSync(join(snapshotPath, "security", "contract.md"), "utf8")).toContain("team-a durable contract");
    expect(readContextTreeReadSnapshotIdentity(snapshotPath, runGit)).toEqual(activation);
    expect(events.slice(beforeReads).every((args) => args[0] !== "fetch" && args[0] !== "pull")).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("makes hierarchy selectors verify and report the snapshot without pulling", async () => {
    const root = tempRoot("ft-byo-read-selector-");
    const remote = createRemoteFixture(root, "team-a", "security");
    const events: string[][] = [];
    const runGit = createRealGitRunner([remote], events);
    const { reader } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });
    const activation = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshot") },
      runGit,
    );
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const command = new Command();
    command.args = [];
    process.chdir(activation.snapshotPath);

    runTreeTreeCommand({
      options: { json: true, debug: false, quiet: false },
      command,
    });

    const output = JSON.parse(stdout.mock.calls.map(([chunk]) => String(chunk)).join("")) as {
      data: { branch: { name: string; warning: string | null }; readSnapshot: unknown };
    };
    expect(output.data.branch).toEqual({
      name: `snapshot:${activation.commit.slice(0, 12)}`,
      isMainline: false,
      warning: null,
    });
    expect(output.data.readSnapshot).toEqual(activation);
    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).not.toContain("pull --ff-only");
    expect(events.filter((args) => args[0] === "fetch")).toHaveLength(1);
  });

  it.each([
    "root NODE.md",
    "nested NODE.md",
    "soft-link leaf",
  ] as const)("rejects a tracked %s symlink that escapes the exact snapshot", async (fixtureKind) => {
    const root = tempRoot("ft-byo-read-symlink-escape-");
    const remote = createRemoteFixture(root, "team-a", "security");
    const outsideNode = join(root, `outside-${fixtureKind.replaceAll(" ", "-")}.md`);
    writeNode(outsideNode, "External mutable node", "outside the selected Team snapshot");

    if (fixtureKind === "root NODE.md") {
      const linkPath = join(remote.seed, "NODE.md");
      rmSync(linkPath);
      symlinkSync(relative(dirname(linkPath), outsideNode), linkPath);
    } else if (fixtureKind === "nested NODE.md") {
      const linkPath = join(remote.seed, "security", "NODE.md");
      rmSync(linkPath);
      symlinkSync(relative(dirname(linkPath), outsideNode), linkPath);
    } else {
      const linkPath = join(remote.seed, "security", "external-contract.md");
      symlinkSync(relative(dirname(linkPath), outsideNode), linkPath);
      writeFileSync(
        join(remote.seed, "security", "contract.md"),
        '---\ntitle: "Team contract"\nowners: [owner]\nsoft_links: ["/security/external-contract.md"]\n---\n\n# Team contract\n',
      );
    }
    pushFixtureChange(remote, `add escaping ${fixtureKind} symlink`);

    const events: string[][] = [];
    const runGit = createRealGitRunner([remote], events);
    const { reader, read } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });
    const snapshotPath = join(root, "snapshots", "unsafe-task");

    await expect(activateContextTreeRead(reader, { teamId: "team-a", snapshotPath }, runGit)).rejects.toMatchObject({
      code: "CONTEXT_TREE_READ_SNAPSHOT_FAILED",
      stage: "snapshot",
    });
    expect(read).toHaveBeenCalledTimes(1);
    expectOnlyOneFetch(events);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(join(root, "snapshots")) ? readFileNames(join(root, "snapshots")) : []).toEqual([]);
  });

  it("keeps relative in-snapshot symlinks only when their final file is fixed by the exact commit", async () => {
    const root = tempRoot("ft-byo-read-safe-symlink-");
    const remote = createRemoteFixture(root, "team-a", "security");
    writeNode(join(remote.seed, "root-source.md"), "Contained root", "tracked by the same commit");
    rmSync(join(remote.seed, "NODE.md"));
    symlinkSync("root-source.md", join(remote.seed, "NODE.md"));
    symlinkSync("NODE.md", join(remote.seed, "README.md"));
    const commit = pushFixtureChange(remote, "use contained tracked Markdown symlinks");

    const events: string[][] = [];
    const runGit = createRealGitRunner([remote], events);
    const { reader } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });
    const activation = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshot") },
      runGit,
    );

    expect(activation.commit).toBe(commit);
    expect(readContextTreeSnapshot(activation.snapshotPath).tree.metadata.title).toBe("Contained root");
    expect(readFileSync(join(activation.snapshotPath, "README.md"), "utf8")).toContain("tracked by the same commit");
    expect(readContextTreeReadSnapshotIdentity(activation.snapshotPath, runGit)).toEqual(activation);
    expectOnlyOneFetch(events);
  });

  it("accepts an exact opaque symlink placeholder when Git checks it out with core.symlinks=false", async () => {
    const root = tempRoot("ft-byo-read-symlink-placeholder-");
    const remote = createRemoteFixture(root, "team-a", "security");
    symlinkSync("NODE.md", join(remote.seed, "README.md"));
    const commit = pushFixtureChange(remote, "add safe root alias");

    const events: string[][] = [];
    const baseRunGit = createRealGitRunner([remote], events);
    const runGit: ContextTreeReadGitRunner = (cwd, args) => {
      const output = baseRunGit(cwd, args);
      if (args[0] === "init") {
        git(cwd, "config", "core.symlinks", "false");
      }
      return output;
    };
    const { reader } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });

    const activation = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshot") },
      runGit,
    );

    expect(activation.commit).toBe(commit);
    expect(lstatSync(join(activation.snapshotPath, "README.md")).isFile()).toBe(true);
    expect(readFileSync(join(activation.snapshotPath, "README.md"), "utf8")).toBe("NODE.md");
    expect(readContextTreeSnapshot(activation.snapshotPath).tree.metadata.title).toBe("Context Tree");
    expect(readContextTreeReadSnapshotIdentity(activation.snapshotPath, runGit)).toEqual(activation);
    expectOnlyOneFetch(events);
  });

  it("keeps a task fixed when the remote advances and refreshes on the next task", async () => {
    const root = tempRoot("ft-byo-read-refresh-");
    const remote = createRemoteFixture(root, "team-a", "product");
    const events: string[][] = [];
    const runGit = createRealGitRunner([remote], events);
    const { reader, read } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });

    const first = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshots", "task-1") },
      runGit,
    );
    const newCommit = pushNode(remote, "product/new-contract.md", "New contract");

    expect(existsSync(join(first.snapshotPath, "product", "new-contract.md"))).toBe(false);
    expect(readContextTreeReadSnapshotIdentity(first.snapshotPath, runGit)?.commit).toBe(first.commit);

    const second = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshots", "task-2") },
      runGit,
    );
    expect(second.commit).toBe(newCommit);
    expect(second.commit).not.toBe(first.commit);
    expect(existsSync(join(second.snapshotPath, "product", "new-contract.md"))).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect(events.filter((args) => args[0] === "fetch")).toHaveLength(2);
  });

  it("isolates Team binding and snapshot identity without an account-global selector", async () => {
    const root = tempRoot("ft-byo-read-teams-");
    const remoteA = createRemoteFixture(root, "team-a", "alpha");
    const remoteB = createRemoteFixture(root, "team-b", "beta");
    const events: string[][] = [];
    const runGit = createRealGitRunner([remoteA, remoteB], events);
    const bindings: Record<string, { repo?: string; branch?: string } | Error> = {
      "team-a": { repo: remoteA.bindingRepo, branch: "main" },
      "team-b": { repo: remoteB.bindingRepo, branch: "main" },
    };
    const { reader, read } = readerFor(bindings);

    const taskA = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshots", "team-a-task") },
      runGit,
    );
    const taskB = await activateContextTreeRead(
      reader,
      { teamId: "team-b", snapshotPath: join(root, "snapshots", "team-b-task") },
      runGit,
    );

    expect(read.mock.calls).toEqual([
      ["team-a", { retry: false }],
      ["team-b", { retry: false }],
    ]);
    expect(taskA.binding.repo).toBe(remoteA.bindingRepo);
    expect(taskB.binding.repo).toBe(remoteB.bindingRepo);
    expect(existsSync(join(taskA.snapshotPath, "alpha", "contract.md"))).toBe(true);
    expect(existsSync(join(taskA.snapshotPath, "beta"))).toBe(false);
    expect(existsSync(join(taskB.snapshotPath, "beta", "contract.md"))).toBe(true);
    expect(existsSync(join(taskB.snapshotPath, "alpha"))).toBe(false);

    bindings["team-a"] = { repo: remoteB.bindingRepo, branch: "main" };
    expect(readFileSync(join(taskA.snapshotPath, "alpha", "contract.md"), "utf8")).toContain("team-a");
    const reboundTask = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshots", "team-a-rebound") },
      runGit,
    );
    expect(reboundTask.binding.repo).toBe(remoteB.bindingRepo);
    expect(existsSync(join(reboundTask.snapshotPath, "beta", "contract.md"))).toBe(true);
  });

  it("fails revoked or wrong-Team authority before fetch or snapshot content", async () => {
    const root = tempRoot("ft-byo-read-authority-");
    const remote = createRemoteFixture(root, "team-a", "security");
    const events: string[][] = [];
    const runGit = createRealGitRunner([remote], events);
    const bindings: Record<string, { repo?: string; branch?: string } | Error> = {
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    };
    const { reader } = readerFor(bindings);
    const activeSnapshot = join(root, "snapshots", "active-task");
    await activateContextTreeRead(reader, { teamId: "team-a", snapshotPath: activeSnapshot }, runGit);
    const fetchesAfterActiveTask = events.filter((args) => args[0] === "fetch").length;

    bindings["team-a"] = new SdkError(403, "private revoked-membership response");
    const revokedSnapshot = join(root, "snapshots", "revoked-task");
    await expect(
      activateContextTreeRead(reader, { teamId: "team-a", snapshotPath: revokedSnapshot }, runGit),
    ).rejects.toMatchObject({
      code: "CONTEXT_TREE_READ_AUTHORITY_FAILED",
      stage: "authority",
      exitCode: 3,
      httpStatus: 403,
    });
    expect(existsSync(revokedSnapshot)).toBe(false);
    expect(events.filter((args) => args[0] === "fetch")).toHaveLength(fetchesAfterActiveTask);
    expect(readFileSync(join(activeSnapshot, "security", "contract.md"), "utf8")).toContain("team-a");

    const wrongTeamSnapshot = join(root, "snapshots", "wrong-team-task");
    await expect(
      activateContextTreeRead(reader, { teamId: "team-unknown", snapshotPath: wrongTeamSnapshot }, runGit),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_READ_AUTHORITY_FAILED", stage: "authority" });
    expect(existsSync(wrongTeamSnapshot)).toBe(false);
  });

  it.each([
    ["unbound", { branch: "main" }, "CONTEXT_TREE_READ_UNBOUND"],
    [
      "invalid binding",
      { repo: "https://user:secret@trees.example/private.git", branch: "main" },
      "CONTEXT_TREE_READ_BINDING_INVALID",
    ],
  ] as const)("fails %s before Git work", async (_label, binding, code) => {
    const root = tempRoot("ft-byo-read-binding-");
    const events: string[][] = [];
    const { reader, read } = readerFor({ "team-a": binding });
    const snapshotPath = join(root, "snapshot");

    await expect(
      activateContextTreeRead(reader, { teamId: "team-a", snapshotPath }, (_cwd, args) => {
        events.push([...args]);
        return "";
      }),
    ).rejects.toMatchObject({ code, stage: "binding" });
    expect(read).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
    expect(existsSync(snapshotPath)).toBe(false);
  });

  it.each([
    ["fetch", "CONTEXT_TREE_READ_FETCH_FAILED"],
    ["commit", "CONTEXT_TREE_READ_COMMIT_FAILED"],
    ["snapshot", "CONTEXT_TREE_READ_SNAPSHOT_FAILED"],
  ] as const)("fails closed at the %s boundary and removes partial state", async (failure, code) => {
    const root = tempRoot(`ft-byo-read-${failure}-`);
    const remote = createRemoteFixture(root, "team-a", "security");
    const events: string[][] = [];
    const baseRunner = createRealGitRunner([remote], events, (_cwd, args) => {
      if (failure === "fetch" && args[0] === "fetch") throw new Error("private fetch credential");
      if (failure === "commit" && args[0] === "rev-parse" && args[2]?.startsWith("refs/remotes/")) {
        return "not-an-exact-commit";
      }
      if (failure === "snapshot" && args[0] === "checkout") throw new Error("private checkout detail");
      return undefined;
    });
    const { reader, read } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });
    const snapshotsRoot = join(root, "snapshots");
    const snapshotPath = join(snapshotsRoot, "failed-task");

    await expect(activateContextTreeRead(reader, { teamId: "team-a", snapshotPath }, baseRunner)).rejects.toMatchObject(
      {
        code,
        stage: failure,
      },
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(existsSync(snapshotPath)).toBe(false);
    expect(existsSync(snapshotsRoot) ? readFileNames(snapshotsRoot) : []).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("credential");
  });

  it("refuses an existing snapshot path before authority or network access", async () => {
    const root = tempRoot("ft-byo-read-existing-");
    const snapshotPath = join(root, "existing");
    mkdirSync(snapshotPath);
    writeFileSync(join(snapshotPath, "sentinel"), "preserve me");
    const events: string[][] = [];
    const { reader, read } = readerFor({ "team-a": { repo: "https://trees.example/team-a.git", branch: "main" } });

    await expect(
      activateContextTreeRead(reader, { teamId: "team-a", snapshotPath }, (_cwd, args) => {
        events.push([...args]);
        return "";
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_READ_SNAPSHOT_FAILED", stage: "snapshot" });
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(readFileSync(join(snapshotPath, "sentinel"), "utf8")).toBe("preserve me");
  });

  it("preserves a broken destination symlink before authority or Git work", async () => {
    const root = tempRoot("ft-byo-read-broken-link-");
    const snapshotPath = join(root, "snapshot");
    symlinkSync(join(root, "missing-target"), snapshotPath);
    const events: string[][] = [];
    const { reader, read } = readerFor({
      "team-a": { repo: "https://trees.example/team-a.git", branch: "main" },
    });

    await expect(
      activateContextTreeRead(reader, { teamId: "team-a", snapshotPath }, (_cwd, args) => {
        events.push([...args]);
        return "";
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_TREE_READ_SNAPSHOT_FAILED", stage: "snapshot" });
    expect(read).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(() => realpathSync(snapshotPath)).toThrow();
  });

  it("fails corrupted marker, commit, or worktree state instead of treating it as a managed checkout", async () => {
    const root = tempRoot("ft-byo-read-corrupt-");
    const remote = createRemoteFixture(root, "team-a", "security");
    const events: string[][] = [];
    const runGit = createRealGitRunner([remote], events);
    const { reader } = readerFor({
      "team-a": { repo: remote.bindingRepo, branch: "main" },
    });
    const activation = await activateContextTreeRead(
      reader,
      { teamId: "team-a", snapshotPath: join(root, "snapshot") },
      runGit,
    );

    git(activation.snapshotPath, "config", "--local", "first-tree-read.commit", "0".repeat(40));
    expect(() => readContextTreeReadSnapshotIdentity(activation.snapshotPath)).toThrowError(
      expect.objectContaining({ code: "CONTEXT_TREE_READ_SNAPSHOT_INVALID" }),
    );

    git(activation.snapshotPath, "config", "--local", "first-tree-read.commit", activation.commit);
    git(activation.snapshotPath, "config", "--local", "--unset", "first-tree-read.snapshot");
    expect(() => readContextTreeReadSnapshotIdentity(activation.snapshotPath)).toThrowError(
      expect.objectContaining({ code: "CONTEXT_TREE_READ_SNAPSHOT_INVALID" }),
    );

    git(activation.snapshotPath, "config", "--local", "first-tree-read.snapshot", "true");
    writeFileSync(join(activation.snapshotPath, "NODE.md"), "locally changed\n");
    expect(() => readContextTreeReadSnapshotIdentity(activation.snapshotPath)).toThrowError(
      expect.objectContaining({ code: "CONTEXT_TREE_READ_SNAPSHOT_INVALID" }),
    );

    git(activation.snapshotPath, "checkout", "--", "NODE.md");
    writeNode(join(activation.snapshotPath, "local-only.md"), "Ignored injection", "not in the exact commit");
    expect(() => readContextTreeReadSnapshotIdentity(activation.snapshotPath)).toThrowError(
      expect.objectContaining({ code: "CONTEXT_TREE_READ_SNAPSHOT_INVALID" }),
    );
  });
});

function readFileNames(path: string): string[] {
  return readdirSync(path);
}
