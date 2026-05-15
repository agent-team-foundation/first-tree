import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  MAX_DOC_SNAPSHOT_BYTES,
  MAX_DOC_SNAPSHOTS_PER_MESSAGE,
  MAX_TOTAL_DOC_SNAPSHOT_BYTES,
  normalizeDocLinkPath,
  type SnapshotDoc,
} from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Scan an outbound agent message for inline markdown links of the form
 * `[text](path.md)` and turn each safely-resolvable target into a
 * snapshot of the file's contents at send time.
 *
 * Only inline `[text](path.md)` is recognised — reference-style links,
 * autolinks, HTML `<a>`, escaped `\[ ... \]`, and image markdown
 * `![alt](...)` are deliberately out of scope (see proposal §非目标).
 * The shared schema enforces canonical path form and the server
 * re-validates byte budgets + sha256 so a misbehaving runtime cannot
 * lodge mismatched data.
 *
 * Resolution is constrained to `root`. Anything that escapes the worktree
 * (absolute path, `..` traversal, symlink pointing to a hidden segment
 * inside or outside root), hides (`.dotfile` / `.dotdir`, `.agent/`), or
 * is missing is dropped — the caller's message still goes through, the
 * offending link simply downgrades to a plain link in the UI.
 */
export async function buildMessageDocumentSnapshots(
  text: string,
  root: string,
): Promise<{ docs: SnapshotDoc[]; skipped: number }> {
  const links = scanInlineMarkdownLinks(text);
  if (links.length === 0) return { docs: [], skipped: 0 };

  const rootReal = await safeRealpath(root);
  if (!rootReal) return { docs: [], skipped: links.length };

  const docs: SnapshotDoc[] = [];
  let totalBytes = 0;
  let skipped = 0;
  const seenCanonical = new Set<string>();

  for (const rawPath of links) {
    if (docs.length >= MAX_DOC_SNAPSHOTS_PER_MESSAGE) {
      skipped += 1;
      continue;
    }
    // Canonicalise the link path BEFORE resolution so on-wire storage
    // matches what the web cache lookup will produce from clicked hrefs.
    const canonical = normalizeDocLinkPath(rawPath);
    if (!canonical || !canonical.toLowerCase().endsWith(".md")) {
      skipped += 1;
      continue;
    }
    if (seenCanonical.has(canonical)) continue;
    seenCanonical.add(canonical);

    const resolved = await resolveWorkspaceFile(rootReal, canonical);
    if (!resolved) {
      skipped += 1;
      continue;
    }

    try {
      const buf = await readFile(resolved);
      if (buf.byteLength > MAX_DOC_SNAPSHOT_BYTES) {
        skipped += 1;
        continue;
      }
      if (totalBytes + buf.byteLength > MAX_TOTAL_DOC_SNAPSHOT_BYTES) {
        skipped += 1;
        continue;
      }
      const content = buf.toString("utf8");
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      docs.push({ path: canonical, sha256, size: buf.byteLength, content });
      totalBytes += buf.byteLength;
    } catch {
      skipped += 1;
    }
  }

  return { docs, skipped };
}

/**
 * Inline markdown link scanner. Conservative: requires a literal `[ ... ](path.md)`
 * pair (with optional title segment ignored) where the path captures up to the
 * first whitespace or `)`. Reference-style / autolink / HTML / escaped /
 * image forms are deliberately not matched (proposal §非目标).
 *
 * Two forms are excluded by inspecting the byte preceding the opening `[`:
 *   - `\[text](path.md)` — markdown-escaped bracket
 *   - `![alt](path.md)` — image, not a click target
 */
function scanInlineMarkdownLinks(text: string): string[] {
  const out: string[] = [];
  // [\s\S] inside the link text class so multi-line text is tolerated.
  const re = /\[(?:[^\]\\]|\\.)*\]\((\S+?\.md)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    const start = match.index;
    const prev = start > 0 ? text[start - 1] : "";
    if (prev !== "\\" && prev !== "!") {
      const raw = match[1];
      if (raw) out.push(raw);
    }
    match = re.exec(text);
  }
  return out;
}

/**
 * Resolve a canonical workspace-relative link target against `rootReal`.
 * Returns the real path of a regular `.md` file that is **physically** inside
 * the worktree AND whose real path contains no hidden segments. The second
 * check is the bit that closes the symlink-into-`.agent` / -`.git` /
 * -dotfile escape: a link like `docs/public.md` could be a symlink whose
 * realpath is `<root>/.agent/secret.md` — link-level segment check would
 * allow it (no dot in `docs/public.md`), so we re-check after realpath.
 *
 * Callers must pass a canonical path (no leading "/", no "./", no "..", no
 * dot segments) — `buildMessageDocumentSnapshots` runs `normalizeDocLinkPath`
 * before invoking this function.
 */
async function resolveWorkspaceFile(rootReal: string, canonicalPath: string): Promise<string | null> {
  if (!canonicalPath || isAbsolute(canonicalPath)) return null;

  const candidate = resolve(rootReal, canonicalPath);
  const candidateReal = await safeRealpath(candidate);
  if (!candidateReal) return null;

  // 1. Real target must still be inside (or equal to) the workspace root.
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep;
  if (candidateReal !== rootReal && !candidateReal.startsWith(prefix)) return null;

  // 2. Real target's path relative to root must not include any hidden
  //    segment. Catches the case where a non-hidden link path points at a
  //    symlink whose realpath drops into `.agent/`, `.git/`, dotfiles, etc.
  const rel = relative(rootReal, candidateReal);
  const realSegments = rel.split(sep).filter((s) => s.length > 0 && s !== ".");
  if (realSegments.some((s) => s.startsWith("."))) return null;

  try {
    const st = await stat(candidateReal);
    if (!st.isFile()) return null;
  } catch {
    return null;
  }
  return candidateReal;
}

async function safeRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}
