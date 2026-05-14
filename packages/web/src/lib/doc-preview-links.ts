const SCHEME_RE = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const MARKDOWN_PATH_RE = /^(?<path>.*?\.md)(?::\d+(?::\d+)?)?$/i;

export type DocPreviewPathOptions = {
  currentDocPath?: string | null;
  basePath?: string | null;
};

export function docPreviewPathFromHref(
  href: string,
  currentDocPathOrOptions?: string | null | DocPreviewPathOptions,
): string | null {
  const options =
    typeof currentDocPathOrOptions === "object" && currentDocPathOrOptions !== null
      ? currentDocPathOrOptions
      : { currentDocPath: currentDocPathOrOptions };
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || SCHEME_RE.test(trimmed)) {
    return null;
  }

  const pathPart = trimmed.split(/[?#]/, 1).at(0) ?? "";
  const markdownMatch = MARKDOWN_PATH_RE.exec(pathPart);
  const markdownPath = markdownMatch?.groups?.path;
  if (!markdownPath) return null;

  let candidate = markdownPath.startsWith("/") ? markdownPath.slice(1) : markdownPath;
  if (options.basePath) {
    candidate = stripBasePathPrefix(candidate, options.basePath);
  }
  if (options.currentDocPath && !markdownPath.startsWith("/")) {
    const slash = options.currentDocPath.lastIndexOf("/");
    const base = slash >= 0 ? options.currentDocPath.slice(0, slash + 1) : "";
    candidate = `${base}${markdownPath}`;
  }

  return normalizeDocPath(candidate);
}

function stripBasePathPrefix(path: string, basePath: string): string {
  const normalizedBase = normalizeDocPath(basePath);
  if (!normalizedBase) return path;
  const pathParts = path.split("/").filter(Boolean);
  const baseParts = normalizedBase.split("/");
  for (let idx = 0; idx <= pathParts.length - baseParts.length; idx++) {
    const matches = baseParts.every((part, offset) => pathParts[idx + offset] === part);
    if (matches) return pathParts.slice(idx + baseParts.length).join("/");
  }
  return path;
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
