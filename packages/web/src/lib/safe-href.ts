const NAVIGABLE_SCHEME_RE = /^(?:https?|mailto|tel):/i;

/**
 * Issue 831 — `true` when an `<a href>` produced by rendered markdown points
 * at a real navigable web target, so it is safe to render as a live anchor.
 *
 * Agents building a context tree routinely write a worktree path such as
 * `/Users/<u>/.first-tree/data/workspaces/<a>/worktrees/<task>` into chat. When
 * that lands inside markdown link syntax, react-markdown's default
 * `urlTransform` keeps the schemeless path verbatim, the browser resolves it
 * against the cloud origin, and the click 404s
 * (`https://cloud.first-tree.ai/Users/...`). Anything that is NOT one of the
 * navigable shapes below has no route on the web app, so callers render the
 * link text as plain text instead of a dead link.
 *
 * Navigable:
 *   - `http:` / `https:` absolute URLs and `//host/…` protocol-relative URLs
 *   - `mailto:` / `tel:` actions
 *   - pure in-page fragments (`#section`) — never leave the page, never 404
 *
 * NOT navigable (render the link text as plain text):
 *   - absolute or relative filesystem paths (`/Users/…`, `~/…`, `src/x`)
 *   - any other scheme (`file:`, `vscode:`, `javascript:`, `ftp:`, …)
 *
 * Doc-preview `.md` paths are intentionally out of scope here: chat / drawer
 * callers resolve those via `docPreviewPathFromHref` BEFORE consulting this
 * guard, so a snapshot-backed `docs/foo.md` still renders as a clickable
 * preview.
 */
export function isNavigableWebHref(href: string | null | undefined): boolean {
  if (typeof href !== "string") return false;
  const trimmed = href.trim();
  if (!trimmed) return false;
  // In-page fragment (`#section`) and protocol-relative (`//host/…`) targets
  // are checked before the scheme test because neither carries a `scheme:`.
  if (trimmed.startsWith("#")) return true;
  if (trimmed.startsWith("//")) return true;
  return NAVIGABLE_SCHEME_RE.test(trimmed);
}
