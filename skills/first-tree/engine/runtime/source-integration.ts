import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FIRST_TREE_INDEX_FILE,
  SKILL_REFERENCES_DIR,
  SOURCE_INTEGRATION_BEGIN,
  SOURCE_INTEGRATION_END,
  SOURCE_INTEGRATION_FILES,
  SOURCE_INTEGRATION_MARKER,
} from "#skill/engine/runtime/asset-loader.js";

export type SourceIntegrationFile = (typeof SOURCE_INTEGRATION_FILES)[number];
const FIRST_TREE_INDEX_BEGIN = "<!-- BEGIN FIRST-TREE INDEX -->";
const FIRST_TREE_INDEX_END = "<!-- END FIRST-TREE INDEX -->";
const REFERENCE_ROOT = SKILL_REFERENCES_DIR.replaceAll("\\", "/");

export interface SourceIntegrationUpdate {
  action: "created" | "updated" | "unchanged";
  file: SourceIntegrationFile;
}

export interface FirstTreeIndexUpdate {
  action: "created" | "updated" | "unchanged" | "skipped";
  file: typeof FIRST_TREE_INDEX_FILE;
}

export interface SourceIntegrationOptions {
  submodulePath?: string;
}

export function buildSourceIntegrationBlock(
  treeRepoName: string,
  options?: SourceIntegrationOptions,
): string {
  const submodulePath = options?.submodulePath ?? treeRepoName;

  return [
    SOURCE_INTEGRATION_BEGIN,
    `${SOURCE_INTEGRATION_MARKER}`,
    "",
    `This repo is a source/workspace repo. Keep all Context Tree files only in the dedicated \`${treeRepoName}\` repo/submodule.`,
    "",
    "Before every task:",
    `- If this workspace already tracks the Context Tree as a git submodule, sync submodules to the commits recorded by the current superproject and read the tracked tree first (preferred path: \`${submodulePath}/\`).`,
    "- If that submodule directory exists but is not initialized locally, initialize only that submodule; do not update every submodule in the workspace.",
    `- If the tree has not been published back to this workspace as a tracked submodule yet, work from the sibling dedicated \`${treeRepoName}\` bootstrap repo instead.`,
    "",
    "After every task:",
    "- Always ask whether the tree needs updating.",
    "- If the task changed decisions, constraints, rationale, or ownership, open a PR in the tree repo first. Then update this repo's Context Tree submodule pointer and open the source/workspace code PR.",
    "- If the task changed only implementation details, skip the tree PR and open only the source/workspace code PR.",
    SOURCE_INTEGRATION_END,
  ].join("\n");
}

export function hasSourceIntegrationMarker(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .some((line) => line.startsWith(SOURCE_INTEGRATION_MARKER));
}

export function upsertFirstTreeIndexFile(
  root: string,
  treeRepoName?: string,
): FirstTreeIndexUpdate {
  const fullPath = join(root, FIRST_TREE_INDEX_FILE);
  const exists = existsSync(fullPath);
  const nextText = buildFirstTreeIndexFile(treeRepoName);
  const current = exists ? readFileSync(fullPath, "utf-8") : null;

  if (current === nextText) {
    return { action: "unchanged", file: FIRST_TREE_INDEX_FILE };
  }

  if (
    current !== null
    && !current.includes(FIRST_TREE_INDEX_BEGIN)
    && !current.includes(FIRST_TREE_INDEX_END)
  ) {
    return { action: "skipped", file: FIRST_TREE_INDEX_FILE };
  }

  writeFileSync(fullPath, nextText);
  return {
    action: exists ? "updated" : "created",
    file: FIRST_TREE_INDEX_FILE,
  };
}

export function upsertSourceIntegrationFiles(
  root: string,
  treeRepoName: string,
  options?: SourceIntegrationOptions,
): SourceIntegrationUpdate[] {
  return SOURCE_INTEGRATION_FILES.map((file) =>
    upsertSourceIntegrationFile(root, file, treeRepoName, options),
  );
}

function upsertSourceIntegrationFile(
  root: string,
  file: SourceIntegrationFile,
  treeRepoName: string,
  options?: SourceIntegrationOptions,
): SourceIntegrationUpdate {
  const fullPath = join(root, file);
  const exists = existsSync(fullPath);
  const current = exists ? readFileSync(fullPath, "utf-8") : null;
  const normalized = current?.replaceAll("\r\n", "\n") ?? "";
  const nextBlock = buildSourceIntegrationBlock(treeRepoName, {
    submodulePath:
      options?.submodulePath ?? detectExistingSubmodulePath(normalized) ?? treeRepoName,
  });
  const managedBlock = /<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->[\s\S]*?<!-- END FIRST-TREE-SOURCE-INTEGRATION -->\n?/;
  const lines = normalized === "" ? [] : normalized.split("\n");
  const markerIndex = lines.findIndex((line) => line.startsWith(SOURCE_INTEGRATION_MARKER));

  if (managedBlock.test(normalized)) {
    const replaced = normalized.replace(managedBlock, `${nextBlock}\n`);
    if (replaced === normalized) {
      return { action: "unchanged", file };
    }
    writeFileSync(fullPath, ensureTrailingNewline(replaced));
    return {
      action: exists ? "updated" : "created",
      file,
    };
  }

  if (markerIndex >= 0) {
    lines.splice(markerIndex, 1, nextBlock);
  } else {
    if (lines.length > 0 && lines.at(-1) !== "") {
      lines.push("");
    }
    lines.push(nextBlock);
  }

  const nextText = ensureTrailingNewline(lines.join("\n"));
  if (nextText === normalized || nextText === `${normalized}\n`) {
    return { action: "unchanged", file };
  }
  writeFileSync(fullPath, nextText);

  return {
    action: exists ? "updated" : "created",
    file,
  };
}

function ensureTrailingNewline(text: string): string {
  if (text !== "" && !text.endsWith("\n")) {
    return `${text}\n`;
  }
  return text;
}

function detectExistingSubmodulePath(text: string): string | null {
  if (text === "") {
    return null;
  }

  const match = text.match(/preferred path: `(.+?)\/`/);
  return match?.[1] ?? null;
}

function buildFirstTreeIndexFile(treeRepoName?: string): string {
  const lines = [
    "# First Tree",
    "",
    FIRST_TREE_INDEX_BEGIN,
    "Use this file as the local entrypoint for the installed `first-tree` workspace integration.",
    "",
    `- [About Context Tree](${REFERENCE_ROOT}/about.md)`,
    `- [Onboarding](${REFERENCE_ROOT}/onboarding.md)`,
    `- [Source/Workspace Installation Contract](${REFERENCE_ROOT}/source-workspace-installation.md)`,
    "",
  ];

  if (treeRepoName) {
    lines.push(
      `The dedicated Context Tree for this workspace lives in the sibling \`${treeRepoName}\` repo/submodule. Keep durable decisions, rationale, and ownership there.`,
      "",
    );
  }

  lines.push(
    "This file is managed by `first-tree init` and `first-tree upgrade`.",
    FIRST_TREE_INDEX_END,
    "",
  );

  return lines.join("\n");
}
