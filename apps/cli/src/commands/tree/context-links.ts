import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import { type ContextContentClass, classifyContextContent } from "./content-class.js";
import { isRecord } from "./shared.js";

export type LocalTreeTarget = {
  contentClass: ContextContentClass;
  escaped: boolean;
  exists: boolean;
  relativePath: string;
};

function stripQueryAndFragment(target: string): string {
  const queryIndex = target.indexOf("?");
  const fragmentIndex = target.indexOf("#");
  const indexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const end = indexes.length === 0 ? target.length : Math.min(...indexes);
  return target.slice(0, end);
}

function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function isWindowsAbsoluteTarget(target: string): boolean {
  return /^[a-z]:[\\/]/iu.test(target) || /^\\/u.test(target);
}

export function isTreeLocalTarget(target: string): boolean {
  const trimmed = target.trim();
  if (isWindowsAbsoluteTarget(decodeTarget(stripQueryAndFragment(trimmed)))) {
    return true;
  }
  return (
    trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("//") && !/^[a-z][a-z\d+.-]*:/iu.test(trimmed)
  );
}

function pathIsInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function targetExists(path: string, softLink: boolean): boolean {
  try {
    const stat = statSync(path);
    if (stat.isFile()) {
      return !softLink || path.endsWith(".md");
    }
    return stat.isDirectory() && (!softLink || existsSync(resolve(path, "NODE.md")));
  } catch {
    return false;
  }
}

export function resolveLocalTreeTarget(options: {
  sourcePath: string;
  target: string;
  treeRoot: string;
  softLink: boolean;
}): LocalTreeTarget | null {
  if (!isTreeLocalTarget(options.target)) {
    return null;
  }

  const decodedTarget = decodeTarget(stripQueryAndFragment(options.target.trim()));
  const withoutSuffix = decodedTarget.replace(/\\/gu, "/");
  if (withoutSuffix.length === 0) {
    return null;
  }

  if (isWindowsAbsoluteTarget(decodedTarget)) {
    return {
      contentClass: classifyContextContent(withoutSuffix),
      escaped: true,
      exists: false,
      relativePath: withoutSuffix,
    };
  }

  const sourceDirectory = posix.dirname(options.sourcePath);
  const relativePath = posix.normalize(
    options.softLink || withoutSuffix.startsWith("/")
      ? withoutSuffix.replace(/^\/+/, "")
      : posix.join(sourceDirectory, withoutSuffix),
  );
  const absoluteRoot = resolve(options.treeRoot);
  const absoluteTarget = resolve(absoluteRoot, relativePath);
  const lexicalEscape = !pathIsInside(absoluteRoot, absoluteTarget);
  let contentClass = classifyContextContent(relativePath);

  if (lexicalEscape) {
    return { contentClass, escaped: true, exists: false, relativePath };
  }

  const exists = targetExists(absoluteTarget, options.softLink);
  if (!exists) {
    return { contentClass, escaped: false, exists: false, relativePath };
  }

  try {
    const realRoot = realpathSync(absoluteRoot);
    const realTarget = realpathSync(absoluteTarget);
    if (!pathIsInside(realRoot, realTarget)) {
      return { contentClass, escaped: true, exists: true, relativePath };
    }
    contentClass = classifyContextContent(relative(realRoot, realTarget).replace(/\\/gu, "/"));
  } catch {
    return { contentClass, escaped: false, exists: false, relativePath };
  }

  return { contentClass, escaped: false, exists: true, relativePath };
}

export function readMarkdownLinkTargets(markdown: string): string[] {
  const root = fromMarkdown(markdown);
  const targets: string[] = [];

  function visit(node: unknown): void {
    if (!isRecord(node)) {
      return;
    }

    if ((node.type === "link" || node.type === "image" || node.type === "definition") && typeof node.url === "string") {
      targets.push(node.url);
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  }

  visit(root);
  return targets;
}
