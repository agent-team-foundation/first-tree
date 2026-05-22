import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TREE_SOURCE_REPOS_FILE } from "./binding-state.js";
import { ensureTrailingNewline, parseGitHubRemoteUrl } from "./shared.js";
import {
  buildTreeCodeRepoIndexNote,
  listKnownTreeCodeRepos,
  type ManagedTreeCodeRepo,
} from "./tree-repo-registry.js";

const ROOT_NODE_FILE = "NODE.md";
const ROOT_REPO_INDEX_BEGIN = "<!-- BEGIN FIRST-TREE-SOURCE-REPO-INDEX -->";
const ROOT_REPO_INDEX_END = "<!-- END FIRST-TREE-SOURCE-REPO-INDEX -->";
const AGENTS_REPO_INDEX_BEGIN = "<!-- BEGIN FIRST-TREE-REPO-INDEX-GUIDE -->";
const AGENTS_REPO_INDEX_END = "<!-- END FIRST-TREE-REPO-INDEX-GUIDE -->";

type SyncAction = "created" | "updated" | "unchanged" | "skipped";

export type SourceRepoIndexSyncResult = {
  agentsAction: SyncAction;
  indexAction: SyncAction;
  rootNodeAction: SyncAction;
};

export function syncTreeSourceRepoIndex(treeRoot: string): SourceRepoIndexSyncResult {
  const repos = listKnownTreeCodeRepos(treeRoot);

  return {
    agentsAction: upsertTreeAgentsRepoGuide(treeRoot),
    indexAction: writeSourceRepoIndex(treeRoot, repos),
    rootNodeAction: upsertRootNodeRepoIndexSection(treeRoot),
  };
}

function formatRemoteCell(repo: ManagedTreeCodeRepo): string {
  const github = parseGitHubRemoteUrl(repo.url);

  if (github === null || github.host !== "github.com") {
    return `\`${repo.url}\``;
  }

  const webUrl = `https://${github.host}/${github.owner}/${github.repo}`;
  return `[${github.owner}/${github.repo}](${webUrl})`;
}

export function buildSourceRepoIndex(repos: ManagedTreeCodeRepo[]): string {
  const lines = [
    "---",
    'title: "Source Repos"',
    "owners: []",
    "---",
    "",
    "# Source Repos",
    "",
    "Generated from the managed code-repo registry block in `AGENTS.md` / `CLAUDE.md`. This is the quickest index of the code repos described by this Context Tree.",
    "",
  ];

  if (repos.length === 0) {
    lines.push("No managed code repos have been recorded yet.", "");
    return `${lines.join("\n")}\n`;
  }

  lines.push(...buildSourceRepoIndexTable(repos));

  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function buildSourceRepoIndexTable(repos: ManagedTreeCodeRepo[]): string[] {
  if (repos.length === 0) {
    return ["No managed code repos have been recorded yet."];
  }

  const lines = ["| Source | GitHub |", "| --- | --- |"];

  for (const repo of repos) {
    lines.push([`| \`${repo.name}\``, `${formatRemoteCell(repo)} |`].join(" | "));
  }

  return lines;
}

function writeSourceRepoIndex(treeRoot: string, repos: ManagedTreeCodeRepo[]): SyncAction {
  const fullPath = join(treeRoot, TREE_SOURCE_REPOS_FILE);
  const next = buildSourceRepoIndex(repos);
  const current = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : null;

  if (current === next) {
    return "unchanged";
  }

  writeFileSync(fullPath, next);
  return current === null ? "created" : "updated";
}

function upsertRootNodeRepoIndexSection(treeRoot: string): SyncAction {
  const fullPath = join(treeRoot, ROOT_NODE_FILE);

  if (!existsSync(fullPath)) {
    return "skipped";
  }

  const current = readFileSync(fullPath, "utf-8");
  const nextBlock = [
    ROOT_REPO_INDEX_BEGIN,
    "## Source Repos",
    "",
    `- **[Source Repos](${TREE_SOURCE_REPOS_FILE})** — Generated index of managed code repos and their GitHub URLs.`,
    ROOT_REPO_INDEX_END,
  ].join("\n");
  const next = upsertManagedBlock(current, nextBlock, {
    begin: ROOT_REPO_INDEX_BEGIN,
    end: ROOT_REPO_INDEX_END,
    insertBefore: /^##\s+Domains\s*$/mu,
  });

  if (next === current) {
    return "unchanged";
  }

  writeFileSync(fullPath, next);
  return "updated";
}

function upsertTreeAgentsRepoGuide(treeRoot: string): SyncAction {
  const fullPath = join(treeRoot, "AGENTS.md");

  if (!existsSync(fullPath)) {
    return "skipped";
  }

  const current = readFileSync(fullPath, "utf-8");
  const nextBlock = [
    AGENTS_REPO_INDEX_BEGIN,
    "## Source Repo Index",
    "",
    buildTreeCodeRepoIndexNote(),
    "- The canonical machine-readable source of truth is the managed code-repo registry block in `AGENTS.md` / `CLAUDE.md`.",
    "- When you need current code, use that repo index to open the relevant source repo as an additional working directory and refresh it locally.",
    AGENTS_REPO_INDEX_END,
  ].join("\n");
  const next = upsertManagedBlock(current, nextBlock, {
    begin: AGENTS_REPO_INDEX_BEGIN,
    end: AGENTS_REPO_INDEX_END,
    insertBefore: /^# Project-Specific Instructions\s*$/mu,
    insertAfter: /<!-- END CONTEXT-TREE FRAMEWORK -->\s*/mu,
  });

  if (next === current) {
    return "unchanged";
  }

  writeFileSync(fullPath, next);
  return "updated";
}

function upsertManagedBlock(
  text: string,
  block: string,
  options: {
    begin: string;
    end: string;
    insertAfter?: RegExp;
    insertBefore?: RegExp;
  },
): string {
  const normalized = ensureTrailingNewline(text.replaceAll("\r\n", "\n"));
  const managedBlock = new RegExp(
    `${escapeForRegExp(options.begin)}[\\s\\S]*?${escapeForRegExp(options.end)}\\n?`,
    "mu",
  );

  if (managedBlock.test(normalized)) {
    return ensureTrailingNewline(normalized.replace(managedBlock, `${block}\n`));
  }

  const insertBeforeMatch = options.insertBefore?.exec(normalized);

  if (insertBeforeMatch && insertBeforeMatch.index >= 0) {
    return ensureTrailingNewline(
      [
        normalized.slice(0, insertBeforeMatch.index).trimEnd(),
        block,
        normalized.slice(insertBeforeMatch.index).trimStart(),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  const insertAfterMatch = options.insertAfter?.exec(normalized);

  if (insertAfterMatch && insertAfterMatch.index >= 0) {
    const insertAt = insertAfterMatch.index + insertAfterMatch[0].length;
    return ensureTrailingNewline(
      [normalized.slice(0, insertAt).trimEnd(), block, normalized.slice(insertAt).trimStart()]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  return ensureTrailingNewline(`${normalized.trimEnd()}\n\n${block}`);
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
