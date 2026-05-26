/**
 * Per-process per-worktree-path mutex.
 *
 * In the per-agent-home cwd model (proposals/agent-session-cwd-redesign.20260519
 * §⑧ R1) two concurrent sessions for the same agent share the same cwd, so
 * two `start()` calls would otherwise race `git worktree add` for the same
 * predeclared worktree path. The proposal accepted "no global lock" for the
 * filesystem at large, but carved out predeclared-worktree creation as the
 * one place where a cheap per-path mutex is decisive.
 *
 * Keys are absolute paths so any two callers hitting the same name serialise
 * — even across handler instances and across the claude-code / codex handler
 * boundary. The map's entries are not removed; the leak is bounded by the
 * count of distinct worktree paths a single process ever touches.
 */
const worktreePathMutex = new Map<string, Promise<void>>();

export async function withWorktreePathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = worktreePathMutex.get(path) ?? Promise.resolve();
  let resolveSelf: () => void = () => {};
  const self = new Promise<void>((res) => {
    resolveSelf = res;
  });
  worktreePathMutex.set(
    path,
    prev.then(
      () => self,
      () => self,
    ),
  );
  // Wait my turn (tolerate prior failures — either way it's our slot now).
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    resolveSelf();
  }
}
