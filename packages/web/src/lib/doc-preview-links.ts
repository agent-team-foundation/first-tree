const SCHEME_RE = /^[a-z][a-z0-9+.-]*:(?!\d)/i;
const MARKDOWN_PATH_RE = /^(?<path>.*?\.md)(?::\d+(?::\d+)?)?$/i;
const DOC_PATH_TOKEN_RE =
  /(^|[\s([{"'])(?<path>(?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_.~+@%-]+\/)*[A-Za-z0-9_.~+@%-]+\.md(?::\d+(?::\d+)?)?)(?=$|[\s)\]}"',.;!?])/g;
const DOMAIN_LIKE_PATH_RE = /^[a-z][a-z0-9.-]*\.[a-z]{2,}\//i;
const HTML_TAG_RE = /<\/?[A-Za-z][^>\n]*>/g;
const INLINE_MARKDOWN_LINK_RE = /\[[^\]\n]*\]\([^)\n]*\)/g;
const REFERENCE_LINK_DEFINITION_RE = /^\s*\[[^\]\n]+\]:\s*\S+/;

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

export function linkifyMarkdownDocPaths(markdown: string, options: DocPreviewPathOptions = {}): string {
  const lines = markdown.split(/(\r?\n)/);
  let inFence = false;

  return lines
    .map((line) => {
      if (line === "\n" || line === "\r\n") return line;

      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      if (/^(?: {4}|\t)/.test(line) || REFERENCE_LINK_DEFINITION_RE.test(line)) return line;

      return linkifyMarkdownDocPathsInLine(line, options);
    })
    .join("");
}

function linkifyMarkdownDocPathsInLine(line: string, options: DocPreviewPathOptions): string {
  const skipRanges = findInlineSkipRanges(line);
  return line.replace(DOC_PATH_TOKEN_RE, (match, boundary: string, path: string, offset: number) => {
    const pathStart = offset + boundary.length;
    if (isInsideAnyRange(pathStart, skipRanges) || !isLikelyPreviewableDocPath(path, options)) {
      return match;
    }
    return `${boundary}[${path}](${path})`;
  });
}

function findInlineSkipRanges(line: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];

  for (const match of line.matchAll(INLINE_MARKDOWN_LINK_RE)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  for (const match of line.matchAll(HTML_TAG_RE)) {
    if (match.index !== undefined) ranges.push({ start: match.index, end: match.index + match[0].length });
  }

  for (let idx = 0; idx < line.length; ) {
    if (line[idx] !== "`") {
      idx += 1;
      continue;
    }
    const start = idx;
    while (line[idx] === "`") idx += 1;
    const ticks = line.slice(start, idx);
    const end = line.indexOf(ticks, idx);
    if (end === -1) continue;
    ranges.push({ start, end: end + ticks.length });
    idx = end + ticks.length;
  }

  return ranges;
}

function isInsideAnyRange(index: number, ranges: Array<{ start: number; end: number }>): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function isLikelyPreviewableDocPath(path: string, options: DocPreviewPathOptions): boolean {
  const firstSegment = path.split("/", 1).at(0) ?? "";
  if (!firstSegment.endsWith(".md") && DOMAIN_LIKE_PATH_RE.test(path)) return false;
  return docPreviewPathFromHref(path, options) !== null;
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
