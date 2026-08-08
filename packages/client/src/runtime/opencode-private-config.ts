import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { acquireWorkspaceFileLock } from "./provider-support/index.js";

const PRIVATE_CONFIG_RELATIVE_ROOT = [".first-tree-workspace", "opencode-config"] as const;
const JOURNAL_FILENAME = "handler-generations.json";
const LOCK_FILENAME = "handler-generations.lock";
const MAX_JOURNAL_ENTRIES = 256;
const PROCESS_INSTANCE_ID = randomUUID();

type HandlerGenerationEntry = Readonly<{
  handlerId: string;
  pid: number;
  processInstanceId: string;
  createdAt: string;
}>;

type HandlerGenerationJournal = Readonly<{
  schemaVersion: 1;
  entries: readonly HandlerGenerationEntry[];
}>;

export type OpenCodePrivateConfigLease = Readonly<{
  materialize: (configContent: string) => OpenCodePrivateConfigMaterialization;
  close: () => Promise<void>;
}>;

export type OpenCodePrivateConfigMaterialization = Readonly<{
  configPath: string;
  cleanup: () => void;
}>;

type FileIdentity = Readonly<{
  dev: number;
  ino: number;
}>;

/**
 * Allocate one handler-owned private-config directory below a stable caller
 * parent. Every filesystem mutation revalidates canonical workspace
 * containment and rejects symlinked/non-directory ancestors before it acts.
 *
 * The persistent lock/journal let a later daemon generation clean directories
 * left by a crashed process. Live sibling handlers keep distinct children, so
 * an old handler's delayed shutdown can never delete a newer handler's root.
 */
export async function acquireOpenCodePrivateConfigLease(input: {
  workspace: string;
  callerScope: string;
  handlerId: string;
}): Promise<OpenCodePrivateConfigLease> {
  assertScope(input.callerScope, "caller scope");
  assertScope(input.handlerId, "handler id");
  const workspaceRoot = canonicalWorkspaceRoot(input.workspace);
  const callerParent = resolveContained(workspaceRoot, [...PRIVATE_CONFIG_RELATIVE_ROOT, input.callerScope]);
  ensureSafeDirectoryChain(workspaceRoot, callerParent);
  const lockPath = join(callerParent, LOCK_FILENAME);
  const lock = await acquireWorkspaceFileLock(lockPath, { timeoutMs: 10_000 });
  const runtimeRoot = join(callerParent, `handler-${input.handlerId}`);
  let handlerIdentity: FileIdentity | null = null;

  try {
    assertSafeDirectoryChain(workspaceRoot, callerParent);
    const journalPath = join(callerParent, JOURNAL_FILENAME);
    const journal = readJournalNoFollow(journalPath);
    const entries: HandlerGenerationEntry[] = [];
    for (const entry of journal.entries) {
      if (isStaleProcessEntry(entry)) {
        removeHandlerChild(workspaceRoot, callerParent, entry.handlerId);
      } else {
        entries.push(entry);
      }
    }
    sweepUnjournaledHandlerChildren(workspaceRoot, callerParent, entries);
    if (entries.some((entry) => entry.handlerId === input.handlerId)) {
      throw new Error("OpenCode private-config handler generation already exists");
    }
    if (entries.length >= MAX_JOURNAL_ENTRIES) {
      throw new Error("OpenCode private-config generation journal exceeded its safety bound");
    }
    handlerIdentity = createHandlerChild(workspaceRoot, callerParent, input.handlerId);
    entries.push({
      handlerId: input.handlerId,
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      createdAt: new Date().toISOString(),
    });
    writeJournalAtomic(journalPath, { schemaVersion: 1, entries });
  } finally {
    await lock.release();
  }

  if (!handlerIdentity) {
    throw new Error("OpenCode private-config handler generation was not created");
  }
  const ownedHandlerIdentity = handlerIdentity;
  const activeProjectionDirectories = new Map<string, FileIdentity>();
  let closed = false;
  return {
    materialize: (configContent) => {
      if (closed) throw new Error("OpenCode private-config lease is closed");
      assertHandlerChildIdentity(workspaceRoot, callerParent, input.handlerId, ownedHandlerIdentity);
      const configDirectory = mkdtempSync(join(runtimeRoot, "turn-"));
      const directoryIdentity = directoryIdentityAt(configDirectory, "projection directory");
      let retained = false;
      try {
        assertHandlerChildIdentity(workspaceRoot, callerParent, input.handlerId, ownedHandlerIdentity);
        assertDirectoryIdentity(configDirectory, directoryIdentity, "projection directory");
        chmodSync(configDirectory, 0o700);
        const configPath = join(configDirectory, "opencode.json");
        writeConfigFileNoFollow(configPath, configContent, () => {
          assertHandlerChildIdentity(workspaceRoot, callerParent, input.handlerId, ownedHandlerIdentity);
          assertDirectoryIdentity(configDirectory, directoryIdentity, "projection directory");
        });
        assertHandlerChildIdentity(workspaceRoot, callerParent, input.handlerId, ownedHandlerIdentity);
        assertDirectoryIdentity(configDirectory, directoryIdentity, "projection directory");
        activeProjectionDirectories.set(configDirectory, directoryIdentity);
        retained = true;
        let cleaned = false;
        return {
          configPath,
          cleanup: () => {
            if (cleaned) return;
            assertHandlerChildIdentity(workspaceRoot, callerParent, input.handlerId, ownedHandlerIdentity);
            assertDirectoryIdentity(configDirectory, directoryIdentity, "projection directory");
            removeDirectoryTreeNoFollow(configDirectory);
            activeProjectionDirectories.delete(configDirectory);
            cleaned = true;
          },
        };
      } finally {
        if (!retained) {
          removeProjectionDirectoryIfOwned(
            workspaceRoot,
            callerParent,
            input.handlerId,
            ownedHandlerIdentity,
            configDirectory,
            directoryIdentity,
          );
        }
      }
    },
    close: async () => {
      if (closed) return;
      if (activeProjectionDirectories.size > 0) {
        throw new Error("OpenCode private-config lease still has active projections");
      }
      assertSafeDirectoryChain(workspaceRoot, callerParent);
      const closeLock = await acquireWorkspaceFileLock(lockPath, { timeoutMs: 10_000 });
      try {
        assertSafeDirectoryChain(workspaceRoot, callerParent);
        const journalPath = join(callerParent, JOURNAL_FILENAME);
        const journal = readJournalNoFollow(journalPath);
        const owned = journal.entries.some(
          (entry) =>
            entry.handlerId === input.handlerId &&
            entry.pid === process.pid &&
            entry.processInstanceId === PROCESS_INSTANCE_ID,
        );
        if (!owned) {
          throw new Error("OpenCode private-config generation ownership changed before shutdown");
        }
        assertHandlerChildIdentity(workspaceRoot, callerParent, input.handlerId, ownedHandlerIdentity);
        removeHandlerChild(workspaceRoot, callerParent, input.handlerId);
        writeJournalAtomic(journalPath, {
          schemaVersion: 1,
          entries: journal.entries.filter((entry) => entry.handlerId !== input.handlerId),
        });
        closed = true;
      } finally {
        await closeLock.release();
      }
    },
  };
}

function canonicalWorkspaceRoot(workspace: string): string {
  const root = realpathSync(resolve(workspace));
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("OpenCode private-config workspace is not a canonical directory");
  }
  return root;
}

function resolveContained(workspaceRoot: string, segments: readonly string[]): string {
  const target = resolve(workspaceRoot, ...segments);
  const rel = relative(workspaceRoot, target);
  if (!rel || rel.startsWith("..") || target === workspaceRoot) {
    throw new Error("OpenCode private-config path escapes the workspace");
  }
  return target;
}

function ensureSafeDirectoryChain(workspaceRoot: string, target: string): void {
  const rel = relative(workspaceRoot, target);
  if (!rel || rel.startsWith("..")) throw new Error("OpenCode private-config directory escapes the workspace");
  let current = workspaceRoot;
  for (const [index, segment] of rel.split(sep).filter(Boolean).entries()) {
    current = join(current, segment);
    try {
      const stats = lstatSync(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`OpenCode private-config ancestor is a symlink: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`OpenCode private-config ancestor is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        mkdirSync(current, { mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      }
      const created = lstatSync(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(`OpenCode private-config directory changed during creation: ${current}`);
      }
    }
    if (index > 0) chmodSync(current, 0o700);
  }
}

function assertSafeDirectoryChain(workspaceRoot: string, target: string): void {
  const rel = relative(workspaceRoot, target);
  if (!rel || rel.startsWith("..")) throw new Error("OpenCode private-config directory escapes the workspace");
  let current = workspaceRoot;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`OpenCode private-config ancestor is a symlink: ${current}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`OpenCode private-config ancestor is not a directory: ${current}`);
    }
  }
}

function createHandlerChild(workspaceRoot: string, callerParent: string, handlerId: string): FileIdentity {
  assertSafeDirectoryChain(workspaceRoot, callerParent);
  const child = join(callerParent, `handler-${handlerId}`);
  try {
    mkdirSync(child, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("OpenCode private-config handler directory already exists");
    }
    throw error;
  }
  const stats = lstatSync(child);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("OpenCode private-config handler directory is not a real directory");
  }
  return { dev: stats.dev, ino: stats.ino };
}

function assertHandlerChildIdentity(
  workspaceRoot: string,
  callerParent: string,
  handlerId: string,
  expected: FileIdentity,
): void {
  assertSafeDirectoryChain(workspaceRoot, callerParent);
  assertDirectoryIdentity(join(callerParent, `handler-${handlerId}`), expected, "handler generation");
}

function directoryIdentityAt(path: string, label: string): FileIdentity {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`OpenCode private-config ${label} is not a real directory`);
  }
  return { dev: stats.dev, ino: stats.ino };
}

function assertDirectoryIdentity(path: string, expected: FileIdentity, label: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev !== expected.dev || stats.ino !== expected.ino) {
    throw new Error(`OpenCode private-config ${label} identity changed`);
  }
}

function writeConfigFileNoFollow(path: string, configContent: string, validateParent: () => void): void {
  validateParent();
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink === 0) {
      throw new Error("OpenCode private-config file is not a live regular file");
    }
    writeFileSync(fd, configContent, "utf8");
    fsyncSync(fd);
    fchmodSync(fd, 0o600);
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new Error("OpenCode private-config file identity changed while writing");
    }
  } finally {
    closeSync(fd);
  }
}

function removeProjectionDirectoryIfOwned(
  workspaceRoot: string,
  callerParent: string,
  handlerId: string,
  handlerIdentity: FileIdentity,
  configDirectory: string,
  directoryIdentity: FileIdentity,
): void {
  try {
    assertHandlerChildIdentity(workspaceRoot, callerParent, handlerId, handlerIdentity);
    assertDirectoryIdentity(configDirectory, directoryIdentity, "projection directory");
    removeDirectoryTreeNoFollow(configDirectory);
  } catch {
    // Fail closed: never follow or remove a path whose containment/identity
    // cannot still be proven.
  }
}

function removeHandlerChild(workspaceRoot: string, callerParent: string, handlerId: string): void {
  assertScope(handlerId, "journal handler id");
  assertSafeDirectoryChain(workspaceRoot, callerParent);
  const child = join(callerParent, `handler-${handlerId}`);
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(child);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("OpenCode private-config owned handler path is not a real directory");
  }
  removeDirectoryTreeNoFollow(child);
}

function sweepUnjournaledHandlerChildren(
  workspaceRoot: string,
  callerParent: string,
  entries: readonly HandlerGenerationEntry[],
): void {
  assertSafeDirectoryChain(workspaceRoot, callerParent);
  const registered = new Set(entries.map((entry) => entry.handlerId));
  for (const name of readdirSync(callerParent)) {
    if (name === JOURNAL_FILENAME || name === LOCK_FILENAME) continue;
    if (!name.startsWith("handler-")) continue;
    const handlerId = name.slice("handler-".length);
    assertScope(handlerId, "orphan handler id");
    if (!registered.has(handlerId)) {
      removeHandlerChild(workspaceRoot, callerParent, handlerId);
    }
  }
}

function removeDirectoryTreeNoFollow(directory: string): void {
  for (const name of readdirSync(directory)) {
    const child = join(directory, name);
    const stats = lstatSync(child);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      removeDirectoryTreeNoFollow(child);
    } else {
      unlinkSync(child);
    }
  }
  rmdirSync(directory);
}

function readJournalNoFollow(path: string): HandlerGenerationJournal {
  let current: ReturnType<typeof lstatSync>;
  try {
    current = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: 1, entries: [] };
    throw error;
  }
  if (current.isSymbolicLink() || !current.isFile()) {
    throw new Error("OpenCode private-config generation journal is not a regular file");
  }
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(fd);
    const afterOpen = lstatSync(path);
    if (
      !opened.isFile() ||
      !afterOpen.isFile() ||
      opened.nlink === 0 ||
      opened.dev !== afterOpen.dev ||
      opened.ino !== afterOpen.ino
    ) {
      throw new Error("OpenCode private-config generation journal changed while opening");
    }
    return parseJournal(JSON.parse(readFileSync(fd, "utf8")) as unknown);
  } finally {
    closeSync(fd);
  }
}

function parseJournal(value: unknown): HandlerGenerationJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenCode private-config generation journal is invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.entries)) {
    throw new Error("OpenCode private-config generation journal has an unsupported schema");
  }
  const entries = record.entries.map((value): HandlerGenerationEntry => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("OpenCode private-config generation journal entry is invalid");
    }
    const entry = value as Record<string, unknown>;
    if (
      typeof entry.handlerId !== "string" ||
      !isScope(entry.handlerId) ||
      typeof entry.pid !== "number" ||
      !Number.isSafeInteger(entry.pid) ||
      entry.pid <= 0 ||
      typeof entry.processInstanceId !== "string" ||
      entry.processInstanceId.length < 16 ||
      typeof entry.createdAt !== "string" ||
      Number.isNaN(Date.parse(entry.createdAt))
    ) {
      throw new Error("OpenCode private-config generation journal entry has invalid fields");
    }
    return {
      handlerId: entry.handlerId,
      pid: entry.pid,
      processInstanceId: entry.processInstanceId,
      createdAt: entry.createdAt,
    };
  });
  if (entries.length > MAX_JOURNAL_ENTRIES) {
    throw new Error("OpenCode private-config generation journal exceeded its safety bound");
  }
  if (new Set(entries.map((entry) => entry.handlerId)).size !== entries.length) {
    throw new Error("OpenCode private-config generation journal has duplicate handlers");
  }
  return { schemaVersion: 1, entries };
}

function writeJournalAtomic(path: string, value: HandlerGenerationJournal): void {
  const tempPath = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
    writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original error.
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
}

function isStaleProcessEntry(entry: HandlerGenerationEntry): boolean {
  if (entry.processInstanceId === PROCESS_INSTANCE_ID) return false;
  if (entry.pid === process.pid) return true;
  try {
    process.kill(entry.pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH";
  }
}

function assertScope(value: string, label: string): void {
  if (!isScope(value)) throw new Error(`invalid OpenCode private-config ${label}`);
}

function isScope(value: string): boolean {
  return /^[a-f0-9]{32,64}$/.test(value);
}
