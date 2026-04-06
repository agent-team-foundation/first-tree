import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  FIRST_TREE_INDEX_FILE,
  LOCAL_TREE_CONFIG,
  LOCAL_TREE_CONFIG_MARKER,
  LOCAL_TREE_TEMP_ROOT,
  SKILL_REFERENCES_DIR,
  SOURCE_INTEGRATION_BEGIN,
  SOURCE_INTEGRATION_END,
  SOURCE_INTEGRATION_FILES,
  SOURCE_INTEGRATION_MARKER,
  TREE_REPO_URL_MARKER,
} from "#skill/engine/runtime/asset-loader.js";

export type SourceIntegrationFile = (typeof SOURCE_INTEGRATION_FILES)[number];
const FIRST_TREE_INDEX_BEGIN = "<!-- BEGIN FIRST-TREE INDEX -->";
const FIRST_TREE_INDEX_END = "<!-- END FIRST-TREE INDEX -->";
export const FIRST_TREE_INDEX_SYMLINK_TARGET = join(
  SKILL_REFERENCES_DIR,
  "about.md",
);

export interface SourceIntegrationUpdate {
  action: "created" | "updated" | "unchanged";
  file: SourceIntegrationFile;
}

export interface FirstTreeIndexUpdate {
  action: "created" | "updated" | "unchanged" | "skipped";
  file: typeof FIRST_TREE_INDEX_FILE;
}

export interface SourceIntegrationOptions {
  localConfigPath?: string;
  treeRepoUrl?: string;
}

export function buildSourceIntegrationBlock(
  treeRepoName: string,
  options?: SourceIntegrationOptions,
): string {
  const localConfigPath = options?.localConfigPath ?? LOCAL_TREE_CONFIG;
  const treeRepoUrl = options?.treeRepoUrl?.trim() || null;
  const temporaryCheckoutPath = join(LOCAL_TREE_TEMP_ROOT, treeRepoName);

  return [
    SOURCE_INTEGRATION_BEGIN,
    `${SOURCE_INTEGRATION_MARKER} dedicated tree repo \`${treeRepoName}\``,
    `${TREE_REPO_URL_MARKER} ${treeRepoUrl === null ? "pending publish" : `\`${treeRepoUrl}\``}`,
    `${LOCAL_TREE_CONFIG_MARKER} \`${localConfigPath}\``,
    "",
    `This repo is a source/workspace repo. Keep all Context Tree files only in the dedicated \`${treeRepoName}\` repo.`,
    "",
    "Before every task:",
    `- Read \`${localConfigPath}\` first. If it exists, resolve its \`localPath\` value from this repo root and treat that checkout as the canonical local tree repo.`,
    "- If that configured checkout exists locally, update it before you read anything else.",
    treeRepoUrl === null
      ? `- If the tree has not been published yet, work from the sibling dedicated \`${treeRepoName}\` bootstrap repo until \`first-tree publish\` records the GitHub repo URL and refreshes the local config.`
      : `- If the configured checkout is missing, clone a temporary working copy from \`${treeRepoUrl}\` into \`${temporaryCheckoutPath}/\`, use it for the current task, and delete it before you finish.`,
    `- Never commit \`${localConfigPath}\` or anything under \`${LOCAL_TREE_TEMP_ROOT}/\` to this repo. They are local-only workspace state.`,
    "",
    "After every task:",
    "- Always ask whether the tree needs updating.",
    "- If the task changed decisions, constraints, rationale, or ownership, open a PR in the tree repo first. Then open the source/workspace code PR.",
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
): FirstTreeIndexUpdate {
  const fullPath = join(root, FIRST_TREE_INDEX_FILE);
  const existingType = detectFirstTreeIndexEntry(fullPath);

  if (existingType === "symlink") {
    if (readlinkSync(fullPath) === FIRST_TREE_INDEX_SYMLINK_TARGET) {
      return { action: "unchanged", file: FIRST_TREE_INDEX_FILE };
    }
    rmSync(fullPath, { force: true });
    symlinkSync(FIRST_TREE_INDEX_SYMLINK_TARGET, fullPath);
    return { action: "updated", file: FIRST_TREE_INDEX_FILE };
  }

  if (existingType === "file") {
    const current = readFileSync(fullPath, "utf-8");
    if (!isManagedFirstTreeIndexFile(current)) {
      return { action: "skipped", file: FIRST_TREE_INDEX_FILE };
    }
    rmSync(fullPath, { force: true });
    symlinkSync(FIRST_TREE_INDEX_SYMLINK_TARGET, fullPath);
    return { action: "updated", file: FIRST_TREE_INDEX_FILE };
  }

  if (existingType === "other") {
    return { action: "skipped", file: FIRST_TREE_INDEX_FILE };
  }

  symlinkSync(FIRST_TREE_INDEX_SYMLINK_TARGET, fullPath);
  return { action: "created", file: FIRST_TREE_INDEX_FILE };
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
    localConfigPath:
      options?.localConfigPath ?? detectExistingLocalConfigPath(normalized) ?? LOCAL_TREE_CONFIG,
    treeRepoUrl:
      options?.treeRepoUrl ?? detectExistingTreeRepoUrl(normalized) ?? undefined,
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

function detectExistingTreeRepoUrl(text: string): string | null {
  if (text === "") {
    return null;
  }

  const match = text.match(
    /^FIRST-TREE-TREE-REPO-URL:\s+`(.+?)`\s*$/m,
  );
  return match?.[1] ?? null;
}

function detectExistingLocalConfigPath(text: string): string | null {
  if (text === "") {
    return null;
  }

  const match = text.match(
    /^FIRST-TREE-LOCAL-TREE-CONFIG:\s+`(.+?)`\s*$/m,
  );
  return match?.[1] ?? null;
}

function detectFirstTreeIndexEntry(
  fullPath: string,
): "missing" | "file" | "symlink" | "other" {
  try {
    const stat = lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      return "symlink";
    }
    if (stat.isFile()) {
      return "file";
    }
    return "other";
  } catch {
    return "missing";
  }
}

function isManagedFirstTreeIndexFile(text: string): boolean {
  return text.includes(FIRST_TREE_INDEX_BEGIN) && text.includes(FIRST_TREE_INDEX_END);
}
