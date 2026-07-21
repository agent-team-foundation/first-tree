#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CONTEXT_REVIEW_HEADING = "## Context Tree Review";
export const REPAIR_CONSENT =
  "The PR author authorizes the configured Context Tree Reviewer to repair only the exact files below.";
export const REPAIR_SCOPE_HEADING = "### Repair scope";

function fail(message) {
  throw new Error(`invalid Context Tree repair scope: ${message}`);
}

function countExactLines(lines, expected) {
  return lines.filter((line) => line === expected).length;
}

function isContractMarker(line) {
  return line === CONTEXT_REVIEW_HEADING || line === REPAIR_CONSENT || line === REPAIR_SCOPE_HEADING;
}

function updateHtmlCommentState(line, initialState) {
  let inComment = initialState;
  let cursor = 0;
  while (cursor < line.length) {
    const delimiter = inComment ? "-->" : "<!--";
    const index = line.indexOf(delimiter, cursor);
    if (index === -1) break;
    inComment = !inComment;
    cursor = index + delimiter.length;
  }
  return inComment;
}

function readFenceOpening(line) {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  if (match[1][0] === "`" && match[2].includes("`")) return null;
  return { marker: match[1][0], length: match[1].length };
}

function isFenceClosing(line, fence) {
  const trimmed = line.replace(/^ {0,3}/, "").trimEnd();
  if (trimmed.length < fence.length || [...trimmed].some((character) => character !== fence.marker)) return false;
  return true;
}

function assertContractMarkersAreVisible(lines) {
  let inHtmlComment = false;
  let fence = null;

  for (const line of lines) {
    if ((inHtmlComment || fence !== null) && isContractMarker(line)) {
      fail("repair-consent markers inside HTML comments or fenced code are not visible authorization");
    }

    if (fence !== null) {
      if (isFenceClosing(line, fence)) fence = null;
      continue;
    }

    inHtmlComment = updateHtmlCommentState(line, inHtmlComment);
    if (inHtmlComment) continue;

    fence = readFenceOpening(line);
  }
}

function isHeadingAtMost(line, maxLevel) {
  const match = /^(#{1,6})\s+/.exec(line);
  return match !== null && match[1].length <= maxLevel;
}

function assertExactFilePath(path) {
  if (path.length === 0 || path !== path.trim() || path !== path.normalize("NFC")) {
    fail("paths must be non-empty, trimmed NFC text");
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) {
    fail(`path must be repository-relative POSIX text: ${JSON.stringify(path)}`);
  }
  if (path.endsWith("/") || path.includes("//")) {
    fail(`directory shorthand is not allowed: ${JSON.stringify(path)}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(`path traversal or non-normalized segments are not allowed: ${JSON.stringify(path)}`);
  }
  if (/[*?[\]{}]/.test(path)) {
    fail(`glob syntax is not allowed: ${JSON.stringify(path)}`);
  }
  if (segments[0] === ".github" || segments.some((segment) => segment.toLowerCase() === "codeowners")) {
    fail(`protected repository path is not repairable: ${JSON.stringify(path)}`);
  }
  if (/\p{Cc}/u.test(path)) {
    fail(`control characters are not allowed: ${JSON.stringify(path)}`);
  }
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function parseRepairScope(body) {
  if (typeof body !== "string") fail("PR body must be text");
  const lines = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

  assertContractMarkersAreVisible(lines);

  if (countExactLines(lines, CONTEXT_REVIEW_HEADING) !== 1) {
    fail(`${CONTEXT_REVIEW_HEADING} must appear exactly once`);
  }
  if (countExactLines(lines, REPAIR_CONSENT) !== 1) {
    fail("the fixed repair-consent sentence must appear exactly once");
  }
  if (countExactLines(lines, REPAIR_SCOPE_HEADING) !== 1) {
    fail(`${REPAIR_SCOPE_HEADING} must appear exactly once`);
  }

  const contextStart = lines.indexOf(CONTEXT_REVIEW_HEADING);
  let contextEnd = lines.length;
  for (let index = contextStart + 1; index < lines.length; index += 1) {
    if (isHeadingAtMost(lines[index], 2)) {
      contextEnd = index;
      break;
    }
  }

  const consentIndex = lines.indexOf(REPAIR_CONSENT);
  const scopeStart = lines.indexOf(REPAIR_SCOPE_HEADING);
  if (
    consentIndex <= contextStart ||
    consentIndex >= contextEnd ||
    scopeStart <= consentIndex ||
    scopeStart >= contextEnd
  ) {
    fail(
      "heading, consent sentence, and Repair scope must occur once in that order in one Context Tree Review section",
    );
  }
  if (
    lines.slice(contextStart + 1, consentIndex).some((line) => line.trim().length > 0) ||
    lines.slice(consentIndex + 1, scopeStart).some((line) => line.trim().length > 0)
  ) {
    fail("the fixed heading/consent/scope sequence may contain only blank separator lines");
  }

  let scopeEnd = contextEnd;
  for (let index = scopeStart + 1; index < contextEnd; index += 1) {
    if (isHeadingAtMost(lines[index], 3)) {
      scopeEnd = index;
      break;
    }
  }

  const repairScope = [];
  for (const line of lines.slice(scopeStart + 1, scopeEnd)) {
    if (line.trim().length === 0) continue;
    const item = /^- `([^`]+)`$/.exec(line);
    if (!item) fail("Repair scope may contain only '- `exact/repository/path`' list items and blank lines");
    assertExactFilePath(item[1]);
    repairScope.push(item[1]);
  }
  if (repairScope.length === 0) fail("Repair scope must contain at least one exact file path");

  const unique = new Set(repairScope);
  if (unique.size !== repairScope.length) fail("Repair scope paths must be deduplicated");
  const sorted = [...repairScope].sort(bytewiseCompare);
  if (sorted.some((path, index) => path !== repairScope[index])) {
    fail("Repair scope paths must be sorted by UTF-8 byte order");
  }

  return repairScope;
}

async function main() {
  const bodyFile = process.argv[2];
  if (!bodyFile || process.argv.length !== 3) {
    throw new Error("usage: parse-repair-scope.mjs <pr-body-file>");
  }
  const body = await readFile(bodyFile, "utf8");
  process.stdout.write(`${JSON.stringify({ repairScope: parseRepairScope(body) })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
