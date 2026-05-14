const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

export function docPreviewPathFromHref(href: string, currentDocPath?: string | null): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || SCHEME_RE.test(trimmed)) {
    return null;
  }

  const pathPart = trimmed.split(/[?#]/, 1).at(0) ?? "";
  if (!pathPart.toLowerCase().endsWith(".md")) return null;

  let candidate = pathPart.startsWith("/") ? pathPart.slice(1) : pathPart;
  if (currentDocPath && !pathPart.startsWith("/")) {
    const slash = currentDocPath.lastIndexOf("/");
    const base = slash >= 0 ? currentDocPath.slice(0, slash + 1) : "";
    candidate = `${base}${pathPart}`;
  }

  return normalizeDocPath(candidate);
}

function normalizeDocPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}
