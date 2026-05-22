import { chmodSync, cpSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Pre-v0.9 path. The home directory was a flat `~/.first-tree/` — this
 * was renamed to `~/.first-tree/hub/` so the `.first-tree/` parent can be
 * shared with sibling products (context-tree etc.) under the same brand.
 */
export const LEGACY_HOME_DIR = join(homedir(), ".first-tree");

export type HomeMigrationResult =
  | {
      migrated: false;
      reason: "no-legacy-dir" | "custom-home" | "new-dir-populated" | "failed";
      from?: string;
      to?: string;
      error?: string;
    }
  | { migrated: true; from: string; to: string };

type MigrateOptions = {
  /**
   * Target home. In production this is `DEFAULT_HOME_DIR`; tests inject a
   * temp path so they can exercise the migration without touching the real
   * user home.
   */
  newHome: string;
  /** Override the legacy source path (for tests). Defaults to `~/.first-tree`. */
  legacyHome?: string;
  /**
   * When set to a truthy value we treat the caller as "home path is
   * user-overridden" and skip migration. Pass `process.env.FIRST_TREE_HOME`
   * from the caller so the shared module stays free of direct env reads.
   */
  envOverride?: string | null | undefined;
};

/**
 * Auto-migrate the legacy `~/.first-tree/` home to the new
 * `~/.first-tree/hub/` layout. Designed to be called once at CLI startup —
 * idempotent, never throws, and skips any case that could merge state.
 *
 * **Copy-only semantics:** the legacy tree is preserved on disk as a safety
 * net. Users can inspect or fall back to it, and can delete it manually
 * once they've confirmed the new location is healthy. Idempotency is
 * therefore keyed on whether the *target* already has content, not on
 * whether the legacy path still exists.
 *
 * Skip rules (in order):
 *   1. `FIRST_TREE_HOME` is set → user is driving the path explicitly.
 *   2. Legacy path doesn't exist → nothing to migrate.
 *   3. New path already has content → treat as already-migrated (or a
 *      conflict the user must resolve). Either way, never merge.
 *
 * Otherwise we recursively copy legacy → new with `cpSync`, preserving
 * mtimes so log rotation and mtime heuristics keep working.
 */
/**
 * Walk `src` depth-first and mirror every directory's mode onto the matching
 * path in `dest`. Skips symlinks (we don't want to chmod whatever they
 * resolve to — that can reach outside the tree). Files are left alone
 * because `cpSync` already preserves file modes.
 */
function syncDirectoryModes(src: string, dest: string): void {
  // Top-level dir is created by cpSync itself; fix it first.
  chmodSync(dest, statSync(src).mode & 0o7777);

  const stack: string[] = [""];
  while (stack.length > 0) {
    const rel = stack.pop();
    if (rel === undefined) break;
    const srcDir = join(src, rel);
    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      // isDirectory() returns false for symlinks (even if they point at a
      // directory), so this naturally skips them.
      if (!entry.isDirectory()) continue;
      const relChild = rel === "" ? entry.name : join(rel, entry.name);
      const mode = statSync(join(src, relChild)).mode & 0o7777;
      chmodSync(join(dest, relChild), mode);
      stack.push(relChild);
    }
  }
}

export function migrateLegacyHome(opts: MigrateOptions): HomeMigrationResult {
  const { newHome, envOverride } = opts;
  const legacyHome = opts.legacyHome ?? LEGACY_HOME_DIR;

  // Rule 1: respect explicit env override — the user is pointing at a
  // non-default home (e.g. isolated test sandbox). Touching anything on
  // their behalf would violate that intent.
  if (envOverride) {
    return { migrated: false, reason: "custom-home" };
  }

  // Rule 2: nothing to migrate.
  if (!existsSync(legacyHome)) {
    return { migrated: false, reason: "no-legacy-dir" };
  }

  // Rule 3: if the new path has content, we treat it as the authoritative
  // state and leave it alone. This covers two cases with identical handling:
  //   - Second+ CLI run after a successful migration (target populated by us).
  //   - Independent fresh install that created the new layout, then the user
  //     later restored a legacy backup alongside — copying on top would mix
  //     two sessions' credentials.
  // An empty target directory (e.g. a sibling product pre-created
  // `~/.first-tree/hub/`) is allowed and we proceed to copy into it.
  if (existsSync(newHome)) {
    try {
      const entries = readdirSync(newHome);
      if (entries.length > 0) {
        return { migrated: false, reason: "new-dir-populated", from: legacyHome, to: newHome };
      }
    } catch (err) {
      return {
        migrated: false,
        reason: "failed",
        from: legacyHome,
        to: newHome,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  try {
    // cpSync handles:
    //   - Creating `newHome` and any missing parents (via `force: true` +
    //     implicit parent creation in recursive mode).
    //   - Cross-filesystem copies (no EXDEV dance needed).
    //   - Symlink preservation (default behavior keeps them as symlinks).
    //   - File mode preservation (credentials.json stays `0600`).
    // Preserve timestamps so mtime-based heuristics (log rotation, "last
    // used" displays) stay meaningful across the migration.
    cpSync(legacyHome, newHome, { recursive: true, preserveTimestamps: true });

    // Node's `fs.cpSync` does NOT preserve **directory** mode bits — it
    // creates intermediate dirs with default mode (0o777 masked by umask,
    // typically 0o755). That's a real security regression for the
    // `config/` subtree, which is 0o700 on the source to hide the
    // credentials listing. Walk the tree once post-copy and restore every
    // directory's mode to match the source.
    syncDirectoryModes(legacyHome, newHome);

    return { migrated: true, from: legacyHome, to: newHome };
  } catch (err) {
    return {
      migrated: false,
      reason: "failed",
      from: legacyHome,
      to: newHome,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
