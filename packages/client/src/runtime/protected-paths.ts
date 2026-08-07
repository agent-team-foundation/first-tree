import { readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

/**
 * Home-relative roots macOS puts behind a TCC "Files & Folders" consent prompt.
 *
 * The daemon probes for installed providers automatically at startup, on
 * reconnect, and on the degraded-capability poll — before the user has chosen
 * anything — so none of that may be the reason macOS asks for Desktop /
 * Documents / Downloads / iCloud access.
 *
 * The cost is bounded and deliberate: a provider binary reachable only through
 * one of these roots is not auto-discovered. Every ordinary install location —
 * Homebrew, `~/.local/bin`, npm-global, pnpm, bun, and the nvm / fnm / volta /
 * mise / asdf trees — is unaffected.
 */
const MACOS_PROTECTED_HOME_SUBPATHS = [
  "Desktop",
  "Documents",
  "Downloads",
  // iCloud Drive, including the "Desktop & Documents Folders" sync target.
  "Library/Mobile Documents",
  // File Provider mounts: OneDrive, Dropbox, Google Drive, Box, …
  "Library/CloudStorage",
] as const;

/**
 * Injectable seam for the ONE syscall this module is allowed to make. Tests use
 * it to assert what was touched, which is the property that matters here: a
 * reviewer can check the ordering by reading the code, but only this can show
 * that no protected path was ever passed to it.
 */
export type ReadLink = (path: string) => string;

/** Give up rather than loop forever on a symlink cycle. */
const MAX_SYMLINK_HOPS = 32;

/** This host's absolute TCC-protected roots. Empty off macOS, where none apply. */
export function protectedRootsOnThisHost(): string[] {
  if (process.platform !== "darwin") return [];
  const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
  return MACOS_PROTECTED_HOME_SUBPATHS.map((sub) => join(home, sub));
}

/**
 * Case-fold for path comparison. The default macOS filesystem is
 * case-INSENSITIVE, so `~/documents/bin` and `~/Documents/bin` are the same
 * directory and a case-sensitive guard would wave one of them through. Folding
 * both sides is also the conservative answer on a case-sensitive volume, where
 * it can only over-reject — never enter a protected folder by accident.
 */
function fold(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function insideAny(path: string, roots: readonly string[]): boolean {
  const candidate = fold(path);
  return roots.some((root) => {
    const folded = fold(root);
    return candidate === folded || candidate.startsWith(`${folded}${sep}`);
  });
}

/**
 * Canonicalize `dir`, or return `null` if doing so would mean reaching into a
 * protected root.
 *
 * This exists because neither a lexical check nor an ordinary resolve can do the
 * job alone. A lexical check cannot see that `~/bin` is a symlink to
 * `~/Documents/bin`; `cd`, `realpath`, `readdir` and `existsSync` find that out
 * only by entering the protected directory — which is the access we are trying
 * to avoid, not a way to detect it.
 *
 * So the path is walked one component at a time from the root. Each component is
 * checked against the protected roots BEFORE it is touched, and the only syscall
 * performed on it is `readlink`, which reads the link's own target and never
 * follows it. A component that is not a symlink is simply appended. Because a
 * symlink's target is re-walked from the root, an expansion that lands in a
 * protected root is caught on the next iteration, before anything inside it is
 * read — which covers a symlinked ancestor as well as a symlinked leaf.
 *
 * EVERY automatic filesystem source must pass a path through here before
 * listing, stat-ing, or searching it. Judging a source safe by where it is
 * *spelled* does not hold: a version-manager root, a temp dir, or a
 * tool-specific directory name can each be a symlink into a protected folder.
 */
export function resolveOutsideProtectedRoots(
  dir: string,
  roots: readonly string[],
  readLink: ReadLink = readlinkSync,
): string | null {
  let pending = resolve(dir).split(sep).filter(Boolean);
  let resolved: string = sep;
  let hops = 0;
  while (pending.length > 0) {
    const [head = "", ...rest] = pending;
    const candidate = join(resolved, head);
    if (insideAny(candidate, roots)) return null;
    let target: string | null = null;
    try {
      target = readLink(candidate);
    } catch {
      // Not a symlink, missing, or unreadable — nothing to follow either way.
      // A missing dir stays in the result and simply fails the caller's
      // existence check, exactly as an unresolved entry did before.
    }
    if (target === null) {
      resolved = candidate;
      pending = rest;
      continue;
    }
    if (++hops > MAX_SYMLINK_HOPS) return null;
    const expanded = isAbsolute(target) ? target : join(resolved, target);
    pending = [...resolve(expanded).split(sep).filter(Boolean), ...rest];
    resolved = sep;
  }
  return resolved;
}

/**
 * {@link resolveOutsideProtectedRoots} against this host's roots. Off macOS
 * there are no protected roots, so the path is returned untouched rather than
 * spending syscalls to reach the same answer.
 */
export function resolveOutsideProtectedRootsOnThisHost(dir: string, readLink: ReadLink = readlinkSync): string | null {
  const roots = protectedRootsOnThisHost();
  if (roots.length === 0) return dir;
  return resolveOutsideProtectedRoots(dir, roots, readLink);
}

/**
 * The gate every AUTOMATIC executable check must pass before it calls `stat` or
 * `access` on a candidate.
 *
 * Vetting the containing directory is not enough, and neither is vetting the
 * source it came from. `~/.local/bin` is no safer a spelling than a
 * version-manager root — `~/.local`, or `bin`, or the `codex` entry inside it
 * can each be a symlink into `~/Documents` — and `statSync` / `accessSync`
 * follow that link, which IS the protected access. So the check happens on the
 * complete candidate path, at the last moment before the syscall, and applies
 * uniformly to every source: daemon `PATH`, fixed well-known dirs,
 * provider-specific dirs, login-shell dirs, version roots, and desktop-app
 * candidates.
 *
 * An explicit operator override (`CLAUDE_CODE_EXECUTABLE`) is user-directed
 * rather than automatic and is deliberately not gated here.
 */
export function automaticCandidateAllowed(candidate: string, readLink?: ReadLink): boolean {
  return resolveOutsideProtectedRootsOnThisHost(candidate, readLink) !== null;
}
