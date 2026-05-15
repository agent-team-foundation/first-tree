import { normalizeDocLinkPath } from "@agent-team-foundation/first-tree-hub-shared";

/**
 * Map an `<a href>` from a chat / drawer markdown render to the canonical
 * workspace-relative path used as the doc-snapshot cache key.
 *
 * External-link guards (scheme / scheme-relative / fragment-only) and
 * canonicalisation live in the shared `normalizeDocLinkPath` so runtime,
 * server, and web all reject and canonicalise identically. This wrapper
 * only contributes the href-specific concerns: strip query/hash, apply
 * the relative-resolve against `currentDocPath`, and require the `.md`
 * suffix.
 */
export function docPreviewPathFromHref(href: string, currentDocPath?: string | null): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;

  const pathPart = trimmed.split(/[?#]/, 1).at(0) ?? "";
  if (!pathPart.toLowerCase().endsWith(".md")) return null;

  // Relative-resolve against the currently-open doc path BEFORE handing off
  // to the shared canonicaliser so a click on `../api.md` from inside
  // `docs/design.md` resolves to `api.md`.
  let candidate = pathPart;
  if (currentDocPath && !pathPart.startsWith("/")) {
    const slash = currentDocPath.lastIndexOf("/");
    const base = slash >= 0 ? currentDocPath.slice(0, slash + 1) : "";
    candidate = `${base}${pathPart}`;
  }

  return normalizeDocLinkPath(candidate);
}
