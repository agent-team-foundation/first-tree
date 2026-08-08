import { constants } from "node:fs";
import { type FileHandle, lstat, open } from "node:fs/promises";
import { createRequire } from "node:module";

type NativeFileLockApi = Readonly<{
  tryLock: (
    fileDescriptor: number,
    offset?: number,
    length?: number,
    options?: Readonly<{ shared?: boolean }>,
  ) => boolean;
  unlock: (fileDescriptor: number, offset?: number, length?: number) => void;
}>;

// Keep the native addon behind Node's CommonJS loader. The Client sources are
// inlined into the published ESM CLI, while this dependency and its platform
// prebuilds are shipped beside that bundle. Bundling the addon's CommonJS
// loader would make `__filename` unavailable and omit the loadable binary.
//
// Load lazily: `provider-support/index` re-exports this module for transitional
// provider-family callers, and binary/capability import graphs must stay able
// to resolve without forcing the native addon (tests also mock `createRequire`).
let nativeFileLockApi: NativeFileLockApi | null = null;

function getNativeFileLockApi(): NativeFileLockApi {
  if (!nativeFileLockApi) {
    nativeFileLockApi = createRequire(import.meta.url)("fs-native-extensions") as NativeFileLockApi;
  }
  return nativeFileLockApi;
}

export type WorkspaceFileLock = Readonly<{
  release: () => Promise<void>;
}>;

export type AcquireWorkspaceFileLockOptions = Readonly<{
  timeoutMs: number;
  /** Test-only observation seam; lock ownership never depends on this callback. */
  onContention?: () => void;
}>;

export class WorkspaceFileLockTimeoutError extends Error {
  override readonly name = "WorkspaceFileLockTimeoutError";
}

/**
 * Hold a kernel-backed exclusive lock on one persistent file.
 *
 * The path is never renamed or removed. Every cooperating contender opens the
 * same inode, and the OS releases the lock if the owner process exits. This
 * avoids stale-file reclamation and its unavoidable inspect/unlink race.
 */
export async function acquireWorkspaceFileLock(
  lockPath: string,
  options: AcquireWorkspaceFileLockOptions,
): Promise<WorkspaceFileLock> {
  const handle = await openStableLockFile(lockPath);
  const startedAt = Date.now();
  let acquired = false;

  try {
    while (true) {
      if (getNativeFileLockApi().tryLock(handle.fd)) {
        acquired = true;
        await assertStableLockFile(lockPath, handle);
        break;
      }
      options.onContention?.();
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new WorkspaceFileLockTimeoutError(
          `timed out waiting for managed skills workspace lock after ${options.timeoutMs}ms`,
        );
      }
      await delay(Math.min(250, 25 + Math.floor((Date.now() - startedAt) / 10)));
    }
  } catch (error) {
    if (acquired) {
      try {
        getNativeFileLockApi().unlock(handle.fd);
      } catch {
        // Closing the descriptor below also releases any held kernel lock.
      }
    }
    await handle.close();
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      let unlockError: unknown;
      try {
        getNativeFileLockApi().unlock(handle.fd);
      } catch (error) {
        unlockError = error;
      }
      await handle.close();
      if (unlockError) throw unlockError;
    },
  };
}

async function openStableLockFile(lockPath: string): Promise<FileHandle> {
  try {
    const current = await lstat(lockPath);
    if (current.isSymbolicLink()) {
      throw new Error("managed skills workspace lock is a symlink; refusing to follow it");
    }
    if (!current.isFile()) {
      throw new Error("managed skills workspace lock is not a regular file; refusing to replace it");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  let handle: FileHandle;
  try {
    handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | noFollow, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error("managed skills workspace lock is a symlink; refusing to follow it");
    }
    throw error;
  }

  try {
    await assertStableLockFile(lockPath, handle);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertStableLockFile(lockPath: string, handle: FileHandle): Promise<void> {
  const [opened, current] = await Promise.all([handle.stat(), lstat(lockPath)]);
  if (
    !opened.isFile() ||
    !current.isFile() ||
    opened.nlink === 0 ||
    opened.dev !== current.dev ||
    opened.ino !== current.ino
  ) {
    throw new Error("managed skills workspace lock path changed while opening; refusing reconciliation");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
