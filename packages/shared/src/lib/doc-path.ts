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

/**
 * Cross-agent workspace doc key.
 *
 * doc-preview snapshots from the SENDER's own workspace keep a bare,
 * base-relative key (`docs/foo.md`) — unchanged, zero-regression. A snapshot
 * of a file in ANOTHER agent's workspace needs a globally-unique key so web's
 * cache lookup is unambiguous: `<agentSlug>/<chatId>/<rel>`, i.e. the path
 * relative to the shared `workspaces/` common root (minus that root). Runtime
 * builds it when it snapshots a sibling-workspace file; web reconstructs the
 * same key from a scanned token to match the snapshot; server parses it to
 * re-check the owner is a chat participant. All three must agree, so the
 * build/parse logic lives here next to `normalizeDocLinkPath`.
 *
 * `chatId` scopes the key to a single chat: a `workspaces/<X>/<chatId>` dir
 * only exists when X has run a session in that chat, so the chatId segment is
 * the structural fence that keeps one chat from previewing another chat's
 * private workspace docs.
 */
export function buildWorkspaceDocKey(agentSlug: string, chatId: string, rel: string): string | null {
  const slug = agentSlug.trim();
  const chat = chatId.trim();
  // slug / chatId must each be a single, non-hidden path segment.
  if (!slug || !chat || slug.includes("/") || chat.includes("/")) return null;
  if (slug.startsWith(".") || chat.startsWith(".")) return null;
  const relNorm = normalizeDocLinkPath(rel);
  if (!relNorm) return null;
  const key = `${slug}/${chat}/${relNorm}`;
  // Re-validate the assembled key so a slug/chatId containing a stray dot
  // segment or other non-canonical token can never produce a key that web
  // would later canonicalise into a different string (silent cache miss).
  return isCanonicalDocLinkPath(key) ? key : null;
}

/**
 * Inverse of {@link buildWorkspaceDocKey}. Splits a canonical key into
 * `{ agentSlug, chatId, rel }`, or `null` when it has fewer than three
 * segments / is non-canonical.
 *
 * NOTE — ambiguity: a bare self key with three or more segments
 * (`docs/sub/a.md`) parses too. Callers that need to tell "global cross key"
 * from "deep self path" apart MUST additionally require `chatId` to equal the
 * current chat's id (chat ids are uuids, so a self subdir literally named the
 * chat id is effectively impossible). See web `chat-view` / server authz.
 */
export function parseWorkspaceDocKey(key: string): { agentSlug: string; chatId: string; rel: string } | null {
  const norm = normalizeDocLinkPath(key);
  if (!norm) return null;
  const segs = norm.split("/");
  if (segs.length < 3) return null;
  const [agentSlug, chatId, ...rest] = segs;
  const rel = rest.join("/");
  if (!agentSlug || !chatId || rel.length === 0) return null;
  return { agentSlug, chatId, rel };
}

/**
 * Heuristic: does this string have the shape of a Hub chat id?
 *
 * Chats are minted with `randomUUID()` (services/chat.ts), so a real chatId is
 * always a 36-char canonical UUID — `xxxxxxxx-xxxx-Mxxx-Nxxx-xxxxxxxxxxxx`
 * where M is the version nibble and N is the variant nibble. We accept any
 * canonical UUID (v1-v7) so the check stays correct if the project rotates
 * the version field in the future.
 *
 * Why this matters: {@link parseWorkspaceDocKey} is structurally ambiguous —
 * a 3+ segment self path (`<localPath>/docs/foo.md`, `worktrees/<task>/x.md`)
 * also splits cleanly into `agentSlug / chatId / rel`. Callers that need to
 * distinguish "real cross-agent global key" from "deep self path that happens
 * to start with a participant slug" use this check: only when the second
 * segment IS a uuid-shaped chatId is the path treated as a cross key (see
 * server `validateDocumentContext` cross-chat fence). Without this, a
 * single-repo agent whose source-repo `localPath` collides with another
 * participant's slug (e.g. both literally `assistant`) would have every
 * relative `docs/x.md` rejected as a cross-chat leak — codex-review P2 on
 * the worktree-fence-widening PR.
 */
const CHAT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function looksLikeChatId(s: string): boolean {
  return CHAT_ID_RE.test(s);
}
