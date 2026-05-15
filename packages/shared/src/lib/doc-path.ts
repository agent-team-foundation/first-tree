/**
 * Workspace-relative markdown doc path normalisation.
 *
 * Shared by:
 *  - web link click handlers (`docPreviewPathFromHref`)
 *  - client runtime snapshot scan (`buildMessageDocumentSnapshots`)
 *  - server snapshot schema refinement (`snapshotDocSchema`)
 *
 * All three must agree on canonical form or runtime stores one shape and
 * web looks up another, producing silent cache misses. The canonical form
 * is POSIX-style ("/"-separated), no leading "/", no "./" / ".." segments,
 * and no empty segments.
 *
 * Returns `null` when:
 *  - the input is an external link (has a scheme like `https:`, `mailto:`,
 *    or is `//`-scheme-relative, or starts with `#` as a pure fragment) —
 *    these must NEVER be interpreted as workspace paths. Runtime would
 *    otherwise try to open `<workspace>/https:/foo/bar.md` on disk;
 *  - the path escapes the workspace (resolves above root);
 *  - the path is empty after normalisation;
 *  - any segment is hidden (".dotfile" / ".agent/" / ".git/") — defence in
 *    depth against link paths that try to walk into hidden dirs.
 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function normalizeDocLinkPath(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // External-link guards — must run before any path canonicalisation so the
  // scheme / authority is not silently re-interpreted as a directory.
  if (trimmed.startsWith("#") || trimmed.startsWith("//") || SCHEME_RE.test(trimmed)) return null;
  // Query / fragment must not be embedded mid-path; web's href layer is
  // responsible for stripping them before handing the path off.
  if (trimmed.includes("?") || trimmed.includes("#")) return null;

  const stripped = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;

  const parts: string[] = [];
  for (const part of stripped.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (part.startsWith(".")) return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * `true` when `path` is already in canonical form per `normalizeDocLinkPath`.
 * Used by the server snapshot schema to reject anything the runtime didn't
 * normalise correctly — the wire format must carry canonical paths so the
 * web cache lookup is deterministic.
 */
export function isCanonicalDocLinkPath(path: string): boolean {
  const normalized = normalizeDocLinkPath(path);
  return normalized !== null && normalized === path;
}
