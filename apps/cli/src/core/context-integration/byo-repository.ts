import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type ContextTreeActiveBinding, canonicalGitRepoIdentity } from "@first-tree/shared";
import { defaultDataDir, defaultHome } from "@first-tree/shared/config";
import { readActiveContextAccountClientId } from "./account-state-guard.js";

const heldLocks = new Set<string>();
const EXACT_COMMIT_RE = /^[0-9a-f]{40,64}$/u;
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/u;

export type ByoRepositorySnapshot = {
  organizationId: string;
  repositoryPath: string;
  commit: string;
};

type RebindJournal = {
  schemaVersion: 1;
  accountClientId: string;
  organizationId: string;
  previousRepository: string;
  targetRepository: string;
  stagingPath: string;
  backupPath: string;
  phase: "prepared" | "old_parked" | "new_promoted";
  startedAt: string;
};

type WriteJournal = {
  schemaVersion: 2;
  accountClientId: string;
  organizationId: string;
  operationId: string;
  worktreePath: string;
  branch: string;
  repository: string;
  bindingBranch: string;
  baseCommit: string;
  planAnchor: string;
  candidateId: string;
  phase: "prepared" | "active";
  createdAt: string;
};

export function ensureByoContextRepository(
  organizationId: string,
  binding: ContextTreeActiveBinding,
  expectedAccountClientId = readActiveContextAccountClientId(),
): ByoRepositorySnapshot {
  return withByoRepositoryMutationLock(organizationId, () => {
    assertAccount(expectedAccountClientId);
    recoverRebind(organizationId, expectedAccountClientId);
    const repositoryPath = byoRepositoryPath(organizationId);
    const targetIdentity = requireRepositoryIdentity(binding.repo);
    if (!existsSync(repositoryPath)) {
      createRepository(repositoryPath, binding.repo);
    } else {
      const currentRemote = git(repositoryPath, ["config", "--get", "remote.origin.url"]);
      const currentIdentity = requireRepositoryIdentity(currentRemote);
      if (currentIdentity !== targetIdentity) {
        rebindRepository(organizationId, repositoryPath, currentRemote, binding.repo, expectedAccountClientId);
      }
    }
    git(repositoryPath, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${binding.branch}:refs/remotes/origin/${binding.branch}`,
    ]);
    const commit = git(repositoryPath, ["rev-parse", "--verify", `refs/remotes/origin/${binding.branch}^{commit}`])
      .trim()
      .toLowerCase();
    if (!EXACT_COMMIT_RE.test(commit)) throw new Error("Context Tree binding did not resolve to an exact commit.");
    assertAccount(expectedAccountClientId);
    return { organizationId, repositoryPath, commit };
  });
}

export function createByoContextWriteWorktree(input: {
  organizationId: string;
  binding: ContextTreeActiveBinding;
  baseCommit: string;
  planAnchor: string;
  candidateId: string;
  expectedAccountClientId?: string;
}): WriteJournal {
  const accountClientId = input.expectedAccountClientId ?? readActiveContextAccountClientId();
  return withByoRepositoryMutationLock(input.organizationId, () => {
    assertPlanAnchor(input.planAnchor);
    if (!input.candidateId) throw new Error("The BYO write candidate identity is required.");
    const repository = ensureByoContextRepository(input.organizationId, input.binding, accountClientId);
    if (repository.commit !== input.baseCommit || !EXACT_COMMIT_RE.test(input.baseCommit)) {
      throw new Error("The Context Tree binding moved after write confirmation. Run write preflight again.");
    }
    const operationId = operationIdForPlan(input.planAnchor);
    const existing = readWriteJournalOrNull(input.organizationId, operationId);
    if (existing) {
      assertWriteJournalMatches(existing, input, accountClientId);
      return recoverWriteJournal(existing, repository.repositoryPath);
    }
    const branch = `first-tree/context-${operationId}`;
    const worktreePath = join(byoOrganizationRoot(input.organizationId), "worktrees", operationId);
    mkdirSync(dirname(worktreePath), { recursive: true, mode: 0o700 });
    const journal: WriteJournal = {
      schemaVersion: 2,
      accountClientId,
      organizationId: input.organizationId,
      operationId,
      worktreePath,
      branch,
      repository: input.binding.repo,
      bindingBranch: input.binding.branch,
      baseCommit: input.baseCommit,
      planAnchor: input.planAnchor,
      candidateId: input.candidateId,
      phase: "prepared",
      createdAt: new Date().toISOString(),
    };
    writePrivateJson(writeJournalPath(input.organizationId, operationId), journal);
    git(repository.repositoryPath, ["worktree", "add", "-b", branch, worktreePath, input.baseCommit]);
    const active = { ...journal, phase: "active" as const };
    writePrivateJson(writeJournalPath(input.organizationId, operationId), active);
    return active;
  });
}

export function finishByoContextWriteWorktree(organizationId: string, operationId: string): void {
  assertSafeId(operationId, "write operation id");
  withByoRepositoryMutationLock(organizationId, () => {
    const journal = readWriteJournalOrNull(organizationId, operationId);
    if (!journal) return;
    assertAccount(journal.accountClientId);
    const repositoryPath = byoRepositoryPath(organizationId);
    if (existsSync(journal.worktreePath)) {
      git(repositoryPath, ["worktree", "remove", journal.worktreePath]);
    }
    git(repositoryPath, ["worktree", "prune"]);
    if (gitSucceeds(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${journal.branch}`])) {
      git(repositoryPath, ["branch", "-D", journal.branch]);
    }
    rmSync(writePlanReceiptPath(organizationId, journal.planAnchor), { force: true });
    rmSync(writeJournalPath(organizationId, operationId), { force: true });
  });
}

export function inspectByoContextWriteWorktree(organizationId: string, planAnchor: string): WriteJournal | null {
  assertPlanAnchor(planAnchor);
  return withByoRepositoryMutationLock(organizationId, () => {
    const journal = readWriteJournalOrNull(organizationId, operationIdForPlan(planAnchor));
    if (!journal) return null;
    assertAccount(journal.accountClientId);
    if (journal.planAnchor !== planAnchor) throw new Error("The BYO write result does not match this exact plan.");
    return recoverWriteJournal(journal, byoRepositoryPath(organizationId));
  });
}

export function withByoRepositoryMutationLock<T>(organizationId: string, action: () => T): T {
  const lockPath = mutationLockPath(organizationId);
  if (heldLocks.has(lockPath)) return action();
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  removeStalePidLock(lockPath);
  let descriptor: number;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new Error(`Another Context Tree repository mutation is active for Team ${organizationId}.`, { cause: error });
  }
  heldLocks.add(lockPath);
  writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  try {
    return action();
  } finally {
    heldLocks.delete(lockPath);
    closeSync(descriptor);
    rmSync(lockPath, { force: true });
  }
}

export function inspectActiveByoWrites(): string[] {
  const stateRoot = join(defaultHome(), "state", "context", "byo");
  if (!existsSync(stateRoot)) return [];
  const active: string[] = [];
  for (const organizationId of readdirSync(stateRoot)) {
    const writesRoot = join(stateRoot, organizationId, "writes");
    if (!existsSync(writesRoot)) continue;
    for (const entry of readdirSync(writesRoot)) {
      if (entry.endsWith(".json")) active.push(`${organizationId}/${entry.slice(0, -5)}`);
    }
  }
  return active;
}

export function byoRepositoryPath(organizationId: string): string {
  return join(byoOrganizationRoot(organizationId), "context-tree.git");
}

function byoOrganizationRoot(organizationId: string): string {
  assertSafeId(organizationId, "organization id");
  return join(defaultDataDir(), "byo", organizationId);
}

function createRepository(repositoryPath: string, remote: string): void {
  const parent = dirname(repositoryPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(parent)) {
    if (/^\.context-tree\.git\.staging-\d+-\d+$/u.test(entry)) {
      rmSync(join(parent, entry), { recursive: true, force: true });
    }
  }
  const stagingPath = join(parent, `.context-tree.git.staging-${process.pid}-${Date.now()}`);
  try {
    git(parent, ["clone", "--bare", "--no-tags", remote, stagingPath]);
    git(stagingPath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
    renameSync(stagingPath, repositoryPath);
  } finally {
    rmSync(stagingPath, { recursive: true, force: true });
  }
}

function rebindRepository(
  organizationId: string,
  repositoryPath: string,
  previousRemote: string,
  targetRemote: string,
  accountClientId: string,
): void {
  const activeWorktrees = git(repositoryPath, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  if (activeWorktrees.length > 1 || inspectOrganizationWriteJournals(organizationId).length > 0) {
    throw new Error("Cannot replace this Team's Context Tree repository while a BYO write worktree is active.");
  }
  const root = byoOrganizationRoot(organizationId);
  const stagingPath = join(root, `.context-tree.git.rebind-${process.pid}-${Date.now()}`);
  const backupPath = join(root, `.context-tree.git.previous-${process.pid}-${Date.now()}`);
  const journal: RebindJournal = {
    schemaVersion: 1,
    accountClientId,
    organizationId,
    previousRepository: previousRemote,
    targetRepository: targetRemote,
    stagingPath,
    backupPath,
    phase: "prepared",
    startedAt: new Date().toISOString(),
  };
  writePrivateJson(rebindJournalPath(organizationId), journal);
  git(root, ["clone", "--bare", "--no-tags", targetRemote, stagingPath]);
  git(stagingPath, ["config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  renameSync(repositoryPath, backupPath);
  writePrivateJson(rebindJournalPath(organizationId), { ...journal, phase: "old_parked" });
  renameSync(stagingPath, repositoryPath);
  writePrivateJson(rebindJournalPath(organizationId), { ...journal, phase: "new_promoted" });
  rmSync(backupPath, { recursive: true, force: true });
  rmSync(rebindJournalPath(organizationId), { force: true });
}

function recoverRebind(organizationId: string, accountClientId: string): void {
  const path = rebindJournalPath(organizationId);
  if (!existsSync(path)) return;
  const journal = parseRebindJournal(JSON.parse(readFileSync(path, "utf8")), organizationId);
  if (journal.accountClientId !== accountClientId) {
    throw new Error("The incomplete Context Tree repository rebind belongs to another local account.");
  }
  const repositoryPath = byoRepositoryPath(organizationId);
  if (journal.phase === "prepared") {
    if (!existsSync(repositoryPath) && existsSync(journal.backupPath)) {
      renameSync(journal.backupPath, repositoryPath);
    } else if (existsSync(repositoryPath) && existsSync(journal.backupPath)) {
      throw new Error("Context Tree repository rebind recovery found both active and parked repositories.");
    }
    if (!existsSync(repositoryPath))
      throw new Error("Context Tree repository rebind recovery lost the active repository.");
    rmSync(journal.stagingPath, { recursive: true, force: true });
  } else if (journal.phase === "old_parked") {
    if (!existsSync(repositoryPath) && existsSync(journal.stagingPath)) {
      renameSync(journal.stagingPath, repositoryPath);
    } else if (!existsSync(repositoryPath) && existsSync(journal.backupPath)) {
      renameSync(journal.backupPath, repositoryPath);
      rmSync(path, { force: true });
      return;
    }
    assertRepositoryMatches(repositoryPath, journal.targetRepository);
    rmSync(journal.backupPath, { recursive: true, force: true });
  } else {
    assertRepositoryMatches(repositoryPath, journal.targetRepository);
    rmSync(journal.backupPath, { recursive: true, force: true });
    rmSync(journal.stagingPath, { recursive: true, force: true });
  }
  rmSync(path, { force: true });
}

function assertRepositoryMatches(repositoryPath: string, expectedRemote: string): void {
  if (!existsSync(repositoryPath)) throw new Error("Promoted Context Tree repository is missing during recovery.");
  const currentRemote = git(repositoryPath, ["config", "--get", "remote.origin.url"]);
  if (requireRepositoryIdentity(currentRemote) !== requireRepositoryIdentity(expectedRemote)) {
    throw new Error("Promoted Context Tree repository identity does not match the rebind journal.");
  }
}

function parseRebindJournal(value: unknown, organizationId: string): RebindJournal {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Context Tree rebind journal.");
  const journal = value as Partial<RebindJournal>;
  const root = byoOrganizationRoot(organizationId);
  const stagingName = typeof journal.stagingPath === "string" ? basename(resolve(journal.stagingPath)) : "";
  const backupName = typeof journal.backupPath === "string" ? basename(resolve(journal.backupPath)) : "";
  if (
    journal.schemaVersion !== 1 ||
    journal.organizationId !== organizationId ||
    !/^client_[a-f0-9]{8}$/u.test(journal.accountClientId ?? "") ||
    typeof journal.previousRepository !== "string" ||
    typeof journal.targetRepository !== "string" ||
    typeof journal.stagingPath !== "string" ||
    typeof journal.backupPath !== "string" ||
    !["prepared", "old_parked", "new_promoted"].includes(String(journal.phase)) ||
    dirname(resolve(journal.stagingPath)) !== root ||
    dirname(resolve(journal.backupPath)) !== root ||
    !/^\.context-tree\.git\.rebind-\d+-\d+$/u.test(stagingName) ||
    !/^\.context-tree\.git\.previous-\d+-\d+$/u.test(backupName) ||
    journal.stagingPath !== join(root, stagingName) ||
    journal.backupPath !== join(root, backupName) ||
    journal.stagingPath === journal.backupPath ||
    typeof journal.startedAt !== "string" ||
    !Number.isFinite(Date.parse(journal.startedAt))
  ) {
    throw new Error("Invalid Context Tree rebind journal.");
  }
  requireRepositoryIdentity(journal.previousRepository);
  requireRepositoryIdentity(journal.targetRepository);
  return journal as RebindJournal;
}

function inspectOrganizationWriteJournals(organizationId: string): string[] {
  const root = join(defaultHome(), "state", "context", "byo", organizationId, "writes");
  return existsSync(root) ? readdirSync(root).filter((entry) => entry.endsWith(".json")) : [];
}

function readWriteJournalOrNull(organizationId: string, operationId: string): WriteJournal | null {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(writeJournalPath(organizationId, operationId), "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw new Error("Invalid BYO write journal.", { cause: error });
  }
  if (typeof value !== "object" || value === null) throw new Error("Invalid BYO write journal.");
  const journal = value as Partial<WriteJournal>;
  const expectedPath = join(byoOrganizationRoot(organizationId), "worktrees", operationId);
  if (
    journal.schemaVersion !== 2 ||
    journal.organizationId !== organizationId ||
    journal.operationId !== operationId ||
    journal.worktreePath !== expectedPath ||
    !/^client_[a-f0-9]{8}$/u.test(journal.accountClientId ?? "") ||
    journal.branch !== `first-tree/context-${operationId}` ||
    !EXACT_COMMIT_RE.test(journal.baseCommit ?? "") ||
    !/^[0-9a-f]{64}$/u.test(journal.planAnchor ?? "") ||
    journal.operationId !== (journal.planAnchor ? operationIdForPlan(journal.planAnchor) : "") ||
    typeof journal.candidateId !== "string" ||
    journal.candidateId.length === 0 ||
    typeof journal.repository !== "string" ||
    typeof journal.bindingBranch !== "string" ||
    typeof journal.createdAt !== "string" ||
    !Number.isFinite(Date.parse(journal.createdAt)) ||
    (journal.phase !== "prepared" && journal.phase !== "active")
  ) {
    throw new Error("Invalid BYO write journal.");
  }
  return journal as WriteJournal;
}

function recoverWriteJournal(journal: WriteJournal, repositoryPath: string): WriteJournal {
  if (!existsSync(repositoryPath)) throw new Error("The BYO write repository is missing during recovery.");
  assertRepositoryMatches(repositoryPath, journal.repository);
  const worktreeExists = existsSync(journal.worktreePath);
  const branchExists = gitSucceeds(repositoryPath, ["show-ref", "--verify", "--quiet", `refs/heads/${journal.branch}`]);
  if (journal.phase === "active") {
    const head = assertRegisteredWriteWorktree(journal, repositoryPath, worktreeExists, branchExists);
    if (!gitSucceeds(journal.worktreePath, ["merge-base", "--is-ancestor", journal.baseCommit, head])) {
      throw new Error("The active BYO write worktree branch or base ancestry is inconsistent.");
    }
    return journal;
  }
  if (worktreeExists) {
    const head = assertRegisteredWriteWorktree(journal, repositoryPath, worktreeExists, branchExists);
    if (head !== journal.baseCommit) {
      throw new Error("The prepared BYO write worktree is incomplete or inconsistent.");
    }
    assertPreparedWriteWorktreeClean(journal);
  } else {
    git(repositoryPath, ["worktree", "prune"]);
    if (branchExists) {
      const branchCommit = git(repositoryPath, ["rev-parse", `refs/heads/${journal.branch}^{commit}`]);
      if (branchCommit !== journal.baseCommit) {
        throw new Error("The prepared BYO write branch no longer matches its exact base.");
      }
      git(repositoryPath, ["branch", "-D", journal.branch]);
    }
    mkdirSync(dirname(journal.worktreePath), { recursive: true, mode: 0o700 });
    git(repositoryPath, ["worktree", "add", "-b", journal.branch, journal.worktreePath, journal.baseCommit]);
  }
  const active = { ...journal, phase: "active" as const };
  writePrivateJson(writeJournalPath(journal.organizationId, journal.operationId), active);
  return active;
}

function assertPreparedWriteWorktreeClean(journal: WriteJournal): void {
  const changes = git(journal.worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (changes.length > 0) {
    throw new Error("The prepared BYO write worktree is not a clean exact-base checkout.");
  }
}

function assertRegisteredWriteWorktree(
  journal: WriteJournal,
  repositoryPath: string,
  worktreeExists: boolean,
  branchExists: boolean,
): string {
  if (!worktreeExists || !branchExists) throw new Error("The BYO write worktree registration is incomplete.");
  const worktreeStat = lstatSync(journal.worktreePath);
  if (worktreeStat.isSymbolicLink() || !worktreeStat.isDirectory()) {
    throw new Error("The BYO write worktree root is not a real directory.");
  }
  const commonDirOutput = git(journal.worktreePath, ["rev-parse", "--git-common-dir"]);
  const commonDir = realpathSync(
    isAbsolute(commonDirOutput) ? commonDirOutput : resolve(journal.worktreePath, commonDirOutput),
  );
  if (commonDir !== realpathSync(repositoryPath)) {
    throw new Error("The BYO write worktree belongs to a different repository.");
  }
  const head = git(journal.worktreePath, ["rev-parse", "HEAD"]);
  const branch = git(journal.worktreePath, ["symbolic-ref", "--short", "HEAD"]);
  const registeredBranch = git(repositoryPath, ["rev-parse", `refs/heads/${journal.branch}^{commit}`]);
  const registeredWorktree = git(repositoryPath, ["worktree", "list", "--porcelain"])
    .split("\n\n")
    .some((block) => {
      const lines = block.split("\n");
      return (
        lines.includes(`worktree ${journal.worktreePath}`) && lines.includes(`branch refs/heads/${journal.branch}`)
      );
    });
  if (branch !== journal.branch || registeredBranch !== head || !registeredWorktree) {
    throw new Error("The BYO write worktree registration does not match its durable journal.");
  }
  return head;
}

function assertWriteJournalMatches(
  journal: WriteJournal,
  input: {
    organizationId: string;
    binding: ContextTreeActiveBinding;
    baseCommit: string;
    planAnchor: string;
    candidateId: string;
  },
  accountClientId: string,
): void {
  if (
    journal.accountClientId !== accountClientId ||
    journal.organizationId !== input.organizationId ||
    journal.planAnchor !== input.planAnchor ||
    journal.candidateId !== input.candidateId ||
    journal.repository !== input.binding.repo ||
    journal.bindingBranch !== input.binding.branch ||
    journal.baseCommit !== input.baseCommit
  ) {
    throw new Error("The durable BYO write result does not match this exact confirmed plan.");
  }
}

function operationIdForPlan(planAnchor: string): string {
  assertPlanAnchor(planAnchor);
  return `write-${planAnchor}`;
}

function writePlanReceiptPath(organizationId: string, planAnchor: string): string {
  return join(dirname(mutationLockPath(organizationId)), "write-plans", `${planAnchor}.json`);
}

function assertPlanAnchor(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error("Invalid Context write plan anchor.");
}

function mutationLockPath(organizationId: string): string {
  assertSafeId(organizationId, "organization id");
  return join(defaultHome(), "state", "context", "byo", organizationId, "mutation.lock");
}

function rebindJournalPath(organizationId: string): string {
  return join(dirname(mutationLockPath(organizationId)), "rebind-journal.json");
}

function writeJournalPath(organizationId: string, operationId: string): string {
  assertSafeId(operationId, "write operation id");
  return join(dirname(mutationLockPath(organizationId)), "writes", `${operationId}.json`);
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function removeStalePidLock(path: string): void {
  try {
    const owner = Number(readFileSync(path, "utf8").trim());
    if (!Number.isInteger(owner) || owner <= 0) return;
    try {
      process.kill(owner, 0);
    } catch (error) {
      if (errorCode(error) === "ESRCH") rmSync(path, { force: true });
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

function gitSucceeds(cwd: string, args: readonly string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd,
      stdio: "ignore",
      timeout: 60_000,
    });
    return true;
  } catch {
    return false;
  }
}

function requireRepositoryIdentity(repository: string): string {
  const identity = canonicalGitRepoIdentity(repository);
  if (!identity) throw new Error("Context Tree repository identity is invalid.");
  return identity.canonical;
}

function assertAccount(expected: string): void {
  if (readActiveContextAccountClientId() !== expected) {
    throw new Error("The active First Tree account changed during the Context Tree repository operation.");
  }
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID_RE.test(value) || basename(value) !== value) throw new Error(`Invalid ${label}.`);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? Reflect.get(error, "code") : undefined;
}
