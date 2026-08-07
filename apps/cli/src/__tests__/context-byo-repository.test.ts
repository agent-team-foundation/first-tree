import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  byoRepositoryPath,
  createByoContextWriteWorktree,
  ensureByoContextRepository,
  finishByoContextWriteWorktree,
  inspectByoContextWriteWorktree,
} from "../core/context-integration/byo-repository.js";

const ACCOUNT_CLIENT_ID = "client_1234abcd";
const roots: string[] = [];
const originalHome = process.env.FIRST_TREE_HOME;
const originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
const originalGitNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

let home = "";
let gitConfig = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "first-tree-byo-repository-home-"));
  roots.push(home);
  process.env.FIRST_TREE_HOME = home;
  gitConfig = join(home, "git-config");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "client.yaml"), `client:\n  id: ${ACCOUNT_CLIENT_ID}\n`);
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  restoreEnvironment("FIRST_TREE_HOME", originalHome);
  restoreEnvironment("GIT_CONFIG_GLOBAL", originalGitConfig);
  restoreEnvironment("GIT_CONFIG_NOSYSTEM", originalGitNoSystem);
});

describe("BYO Context Tree repository manager", () => {
  it("shares one bare repository across providers and branches within an organization", () => {
    const remote = createRemote("shared", "https://example.test/acme/context-tree.git");
    const main = ensureByoContextRepository("org-acme", {
      provider: "github",
      repo: remote.url,
      branch: "main",
    });
    const release = ensureByoContextRepository("org-acme", {
      provider: "gitlab",
      repo: remote.url,
      branch: "release",
    });

    expect(main.repositoryPath).toBe(byoRepositoryPath("org-acme"));
    expect(release.repositoryPath).toBe(main.repositoryPath);
    expect(release.commit).not.toBe(main.commit);
    expect(
      execFileSync("git", ["-C", main.repositoryPath, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(remote.url);
  });

  it("physically isolates different organizations even when they bind the same repository", () => {
    const remote = createRemote("shared", "https://example.test/acme/context-tree.git");
    const first = ensureByoContextRepository("org-a", { repo: remote.url, branch: "main" });
    const second = ensureByoContextRepository("org-b", { repo: remote.url, branch: "main" });

    expect(first.commit).toBe(second.commit);
    expect(first.repositoryPath).not.toBe(second.repositoryPath);
    expect(existsSync(first.repositoryPath)).toBe(true);
    expect(existsSync(second.repositoryPath)).toBe(true);
  });

  it("blocks rebind while a write is active, then atomically replaces the repository after finish", () => {
    const firstRemote = createRemote("first", "https://example.test/acme/context-tree.git");
    const secondRemote = createRemote("second", "https://example.test/acme/other-tree.git");
    const first = ensureByoContextRepository("org-acme", { repo: firstRemote.url, branch: "main" });
    const write = createByoContextWriteWorktree({
      organizationId: "org-acme",
      binding: { repo: firstRemote.url, branch: "main" },
      baseCommit: first.commit,
      planAnchor: "a".repeat(64),
      candidateId: "candidate-a",
    });

    expect(() => ensureByoContextRepository("org-acme", { repo: secondRemote.url, branch: "main" })).toThrow(
      "while a BYO write worktree is active",
    );
    finishByoContextWriteWorktree("org-acme", write.operationId);

    const rebound = ensureByoContextRepository("org-acme", { repo: secondRemote.url, branch: "main" });
    expect(rebound.commit).not.toBe(first.commit);
    expect(rebound.repositoryPath).toBe(first.repositoryPath);
    expect(
      execFileSync("git", ["-C", rebound.repositoryPath, "config", "--get", "remote.origin.url"], {
        encoding: "utf8",
      }).trim(),
    ).toBe(secondRemote.url);
    expect(existsSync(join(home, "state", "context", "byo", "org-acme", "rebind-journal.json"))).toBe(false);
  });

  it("uses the organization mutation lock for repository metadata changes", () => {
    const remote = createRemote("locked", "https://example.test/acme/context-tree.git");
    const lock = join(home, "state", "context", "byo", "org-acme", "mutation.lock");
    mkdirSync(join(home, "state", "context", "byo", "org-acme"), { recursive: true });
    writeFileSync(lock, `${process.pid}\n`);

    expect(() => ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" })).toThrow(
      "Another Context Tree repository mutation is active",
    );
    expect(existsSync(byoRepositoryPath("org-acme"))).toBe(false);
  });

  it.each([
    "prepared",
    "old_parked",
    "new_promoted",
  ] as const)("recovers the %s rebind crash phase to one authoritative repository", (phase) => {
    const firstRemote = createRemote(`crash-${phase}-first`, "https://example.test/acme/context-tree.git");
    const secondRemote = createRemote(`crash-${phase}-second`, "https://example.test/acme/other-tree.git");
    ensureByoContextRepository("org-acme", { repo: firstRemote.url, branch: "main" });
    const organizationRoot = join(home, "data", "byo", "org-acme");
    const repository = byoRepositoryPath("org-acme");
    const stagingPath = join(organizationRoot, ".context-tree.git.rebind-123-456");
    const backupPath = join(organizationRoot, ".context-tree.git.previous-123-456");
    execFileSync("git", ["clone", "--bare", "--no-tags", secondRemote.url, stagingPath]);
    execFileSync("git", ["-C", stagingPath, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    if (phase === "old_parked" || phase === "new_promoted") renameSync(repository, backupPath);
    if (phase === "new_promoted") renameSync(stagingPath, repository);
    const journal = join(home, "state", "context", "byo", "org-acme", "rebind-journal.json");
    mkdirSync(join(journal, ".."), { recursive: true });
    writeFileSync(
      journal,
      `${JSON.stringify({
        schemaVersion: 1,
        accountClientId: ACCOUNT_CLIENT_ID,
        organizationId: "org-acme",
        previousRepository: firstRemote.url,
        targetRepository: secondRemote.url,
        stagingPath,
        backupPath,
        phase,
        startedAt: new Date().toISOString(),
      })}\n`,
    );

    const binding = phase === "prepared" ? firstRemote : secondRemote;
    const recovered = ensureByoContextRepository("org-acme", { repo: binding.url, branch: "main" });

    expect(recovered.repositoryPath).toBe(repository);
    expect(existsSync(journal)).toBe(false);
    expect(existsSync(stagingPath)).toBe(false);
    expect(existsSync(backupPath)).toBe(false);
    expect(
      execFileSync("git", ["-C", repository, "config", "--get", "remote.origin.url"], { encoding: "utf8" }).trim(),
    ).toBe(binding.url);
  });

  it.each(["before", "after"] as const)("recovers a prepared Write interrupted %s worktree add", (phase) => {
    const remote = createRemote(`write-${phase}`, "https://example.test/acme/context-tree.git");
    const repository = ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" });
    const planAnchor = (phase === "before" ? "b" : "c").repeat(64);
    const operationId = `write-${planAnchor}`;
    const worktreePath = join(home, "data", "byo", "org-acme", "worktrees", operationId);
    const branch = `first-tree/context-${operationId}`;
    const journal = join(home, "state", "context", "byo", "org-acme", "writes", `${operationId}.json`);
    mkdirSync(join(journal, ".."), { recursive: true });
    writeFileSync(
      journal,
      `${JSON.stringify({
        schemaVersion: 2,
        accountClientId: ACCOUNT_CLIENT_ID,
        organizationId: "org-acme",
        operationId,
        worktreePath,
        branch,
        repository: remote.url,
        bindingBranch: "main",
        baseCommit: repository.commit,
        planAnchor,
        candidateId: `candidate-${phase}`,
        phase: "prepared",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    if (phase === "after") {
      mkdirSync(join(worktreePath, ".."), { recursive: true });
      execFileSync("git", [
        "-C",
        repository.repositoryPath,
        "worktree",
        "add",
        "-b",
        branch,
        worktreePath,
        repository.commit,
      ]);
    }

    const recovered = inspectByoContextWriteWorktree("org-acme", planAnchor);

    expect(recovered).toMatchObject({ operationId, phase: "active", planAnchor });
    expect(existsSync(worktreePath)).toBe(true);
    finishByoContextWriteWorktree("org-acme", operationId);

    expect(existsSync(journal)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
    expect(() =>
      execFileSync("git", ["-C", repository.repositoryPath, "show-ref", "--verify", `refs/heads/${branch}`], {
        stdio: "ignore",
      }),
    ).toThrow();
  });

  it("rejects a detached prepared worktree before promoting its journal", () => {
    const remote = createRemote("prepared-detached", "https://example.test/acme/context-tree.git");
    const repository = ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" });
    const prepared = writePreparedJournal(remote.url, repository.commit, "f".repeat(64));
    execFileSync("git", ["-C", repository.repositoryPath, "branch", prepared.branch, repository.commit]);
    mkdirSync(join(prepared.worktreePath, ".."), { recursive: true });
    execFileSync("git", [
      "-C",
      repository.repositoryPath,
      "worktree",
      "add",
      "--detach",
      prepared.worktreePath,
      repository.commit,
    ]);

    expect(() => inspectByoContextWriteWorktree("org-acme", prepared.planAnchor)).toThrow();
    expect(JSON.parse(readFileSync(prepared.journalPath, "utf8"))).toMatchObject({ phase: "prepared" });
  });

  it("rejects a partial prepared checkout before promoting its journal", () => {
    const remote = createRemote("prepared-partial", "https://example.test/acme/context-tree.git");
    const repository = ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" });
    const prepared = writePreparedJournal(remote.url, repository.commit, "8".repeat(64));
    mkdirSync(join(prepared.worktreePath, ".."), { recursive: true });
    execFileSync("git", [
      "-C",
      repository.repositoryPath,
      "worktree",
      "add",
      "-b",
      prepared.branch,
      prepared.worktreePath,
      repository.commit,
    ]);
    rmSync(join(prepared.worktreePath, "SCOPE.md"));

    expect(() => inspectByoContextWriteWorktree("org-acme", prepared.planAnchor)).toThrow(
      "not a clean exact-base checkout",
    );
    expect(JSON.parse(readFileSync(prepared.journalPath, "utf8"))).toMatchObject({ phase: "prepared" });
  });

  it("rejects a prepared worktree registered to another repository", () => {
    const remote = createRemote("prepared-wrong-repo", "https://example.test/acme/context-tree.git");
    const repository = ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" });
    const prepared = writePreparedJournal(remote.url, repository.commit, "9".repeat(64));
    execFileSync("git", ["-C", repository.repositoryPath, "branch", prepared.branch, repository.commit]);
    mkdirSync(join(prepared.worktreePath, ".."), { recursive: true });
    execFileSync("git", ["-C", repository.repositoryPath, "worktree", "add", prepared.worktreePath, prepared.branch]);
    renameSync(prepared.worktreePath, `${prepared.worktreePath}.parked`);
    const otherRoot = mkdtempSync(join(tmpdir(), "first-tree-byo-other-repo-"));
    const otherBare = join(otherRoot, "other.git");
    roots.push(otherRoot);
    execFileSync("git", ["clone", "--bare", repository.repositoryPath, otherBare]);
    execFileSync("git", ["-C", otherBare, "worktree", "add", prepared.worktreePath, prepared.branch]);

    expect(() => inspectByoContextWriteWorktree("org-acme", prepared.planAnchor)).toThrow(
      "belongs to a different repository",
    );
    expect(JSON.parse(readFileSync(prepared.journalPath, "utf8"))).toMatchObject({ phase: "prepared" });
  });

  it("returns one durable result when the exact confirmed write command is retried", () => {
    const remote = createRemote("idempotent", "https://example.test/acme/context-tree.git");
    const repository = ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" });
    const input = {
      organizationId: "org-acme",
      binding: { repo: remote.url, branch: "main" },
      baseCommit: repository.commit,
      planAnchor: "d".repeat(64),
      candidateId: "candidate-idempotent",
    };

    const first = createByoContextWriteWorktree(input);
    const retried = createByoContextWriteWorktree(input);
    const queried = inspectByoContextWriteWorktree("org-acme", input.planAnchor);

    expect(retried.operationId).toBe(first.operationId);
    expect(retried.worktreePath).toBe(first.worktreePath);
    expect(queried).toMatchObject({ operationId: first.operationId, phase: "active" });
    expect(
      execFileSync("git", ["-C", repository.repositoryPath, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      })
        .split("\n")
        .filter((line) => line.startsWith("worktree ")),
    ).toHaveLength(2);

    finishByoContextWriteWorktree("org-acme", first.operationId);
    expect(() => finishByoContextWriteWorktree("org-acme", first.operationId)).not.toThrow();
  });

  it("keeps an active authoring worktree recoverable after its branch advances", () => {
    const remote = createRemote("authoring", "https://example.test/acme/context-tree.git");
    const repository = ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" });
    const planAnchor = "e".repeat(64);
    const write = createByoContextWriteWorktree({
      organizationId: "org-acme",
      binding: { repo: remote.url, branch: "main" },
      baseCommit: repository.commit,
      planAnchor,
      candidateId: "candidate-authoring",
    });
    execFileSync("git", ["-C", write.worktreePath, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", write.worktreePath, "config", "user.name", "Test"]);
    for (const index of [1, 2]) {
      writeFileSync(join(write.worktreePath, `decision-${index}.md`), `decision ${index}\n`);
      execFileSync("git", ["-C", write.worktreePath, "add", `decision-${index}.md`]);
      execFileSync("git", ["-C", write.worktreePath, "commit", "-m", `decision ${index}`]);
    }

    const recovered = inspectByoContextWriteWorktree("org-acme", planAnchor);
    expect(recovered).toMatchObject({ operationId: write.operationId, phase: "active", baseCommit: repository.commit });
    expect(
      execFileSync("git", ["-C", write.worktreePath, "merge-base", "--is-ancestor", repository.commit, "HEAD"], {
        stdio: "ignore",
      }),
    ).toBeDefined();

    finishByoContextWriteWorktree("org-acme", write.operationId);
    expect(existsSync(write.worktreePath)).toBe(false);
  });

  it("fails closed when a second process holds the same organization mutation lock", async () => {
    const remote = createRemote("multiprocess", "https://example.test/acme/context-tree.git");
    const lock = join(home, "state", "context", "byo", "org-acme", "mutation.lock");
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');const p=process.argv[1];fs.mkdirSync(require('node:path').dirname(p),{recursive:true});fs.writeFileSync(p,process.pid+'\\n',{flag:'wx'});process.stdout.write('ready\\n');setInterval(()=>{},1000);",
        lock,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error("lock holder did not become ready")), 5_000);
        child.once("error", reject);
        child.stdout.once("data", () => {
          clearTimeout(timeout);
          resolveReady();
        });
      });
      expect(() => ensureByoContextRepository("org-acme", { repo: remote.url, branch: "main" })).toThrow(
        "Another Context Tree repository mutation is active",
      );
      expect(existsSync(byoRepositoryPath("org-acme"))).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
      rmSync(lock, { force: true });
    }
  });
});

function createRemote(name: string, url: string): { url: string } {
  const root = mkdtempSync(join(tmpdir(), `first-tree-byo-remote-${name}-`));
  roots.push(root);
  const work = join(root, "work");
  const bare = join(root, "remote.git");
  execFileSync("git", ["init", "-b", "main", work]);
  execFileSync("git", ["-C", work, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", work, "config", "user.name", "Test"]);
  writeFileSync(join(work, "SCOPE.md"), `---\nschemaVersion: 1\n---\n${name} main\n`);
  execFileSync("git", ["-C", work, "add", "SCOPE.md"]);
  execFileSync("git", ["-C", work, "commit", "-m", `${name} main`]);
  execFileSync("git", ["-C", work, "checkout", "-b", "release"]);
  writeFileSync(join(work, "SCOPE.md"), `---\nschemaVersion: 1\n---\n${name} release\n`);
  execFileSync("git", ["-C", work, "commit", "-am", `${name} release`]);
  execFileSync("git", ["clone", "--bare", work, bare]);
  execFileSync("git", ["config", "--file", gitConfig, `url.file://localhost${bare}.insteadOf`, url]);
  return { url };
}

function writePreparedJournal(repository: string, baseCommit: string, planAnchor: string) {
  const operationId = `write-${planAnchor}`;
  const worktreePath = join(home, "data", "byo", "org-acme", "worktrees", operationId);
  const branch = `first-tree/context-${operationId}`;
  const journalPath = join(home, "state", "context", "byo", "org-acme", "writes", `${operationId}.json`);
  mkdirSync(join(journalPath, ".."), { recursive: true });
  writeFileSync(
    journalPath,
    `${JSON.stringify({
      schemaVersion: 2,
      accountClientId: ACCOUNT_CLIENT_ID,
      organizationId: "org-acme",
      operationId,
      worktreePath,
      branch,
      repository,
      bindingBranch: "main",
      baseCommit,
      planAnchor,
      candidateId: "candidate-prepared",
      phase: "prepared",
      createdAt: new Date().toISOString(),
    })}\n`,
  );
  return { operationId, worktreePath, branch, journalPath, planAnchor };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
