#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_PROGRESS_PATHS = [
  ".first-tree/progress.md",
  ".agents/skills/first-tree/progress.md",
  "skills/first-tree/progress.md",
  ".context-tree/progress.md",
];

const TREE_CONTENT_GROUPS = new Set(["Root Node", "Members", "Populate Tree"]);
const VERIFICATION_GROUPS = new Set(["Verification"]);

export function classifyProgressGroup(group) {
  if (VERIFICATION_GROUPS.has(group)) {
    return "verification";
  }
  if (TREE_CONTENT_GROUPS.has(group)) {
    return "treeContent";
  }
  return "integration";
}

export function parseProgressMarkdown(markdown) {
  const groups = [];
  let currentGroup = null;

  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^##\s+(.+)$/u.exec(line);
    if (heading !== null) {
      currentGroup = {
        group: heading[1].trim(),
        tasks: [],
      };
      groups.push(currentGroup);
      continue;
    }

    const task = /^- \[( |x|X)\] (.+)$/u.exec(line);
    if (task !== null && currentGroup !== null) {
      currentGroup.tasks.push({
        done: task[1].toLowerCase() === "x",
        text: task[2].trim(),
      });
    }
  }

  return groups;
}

function summarizeLane(groups, category) {
  const laneGroups = groups
    .filter((group) => classifyProgressGroup(group.group) === category)
    .map((group) => ({
      group: group.group,
      completed: group.tasks.filter((task) => task.done).length,
      total: group.tasks.length,
      remainingTasks: group.tasks
        .filter((task) => !task.done)
        .map((task) => `${group.group}: ${task.text}`),
    }));

  return {
    completed: laneGroups.reduce((sum, group) => sum + group.completed, 0),
    total: laneGroups.reduce((sum, group) => sum + group.total, 0),
    groups: laneGroups,
    remainingTasks: laneGroups.flatMap((group) => group.remainingTasks),
  };
}

export function summarizeProgressMarkdown(markdown) {
  const groups = parseProgressMarkdown(markdown);
  return {
    integration: summarizeLane(groups, "integration"),
    treeContent: summarizeLane(groups, "treeContent"),
    verification: summarizeLane(groups, "verification"),
  };
}

function appendRemainingSection(lines, heading, tasks) {
  if (tasks.length === 0) {
    return;
  }

  lines.push(heading);
  for (const task of tasks) {
    lines.push(`- ${task}`);
  }
}

export function formatProgressSummary(summary) {
  const lines = [
    "Onboarding progress checkpoint",
    `- Setup and integration: ${summary.integration.completed}/${summary.integration.total} tasks complete`,
    `- Tree content baseline coverage: ${summary.treeContent.completed}/${summary.treeContent.total} tasks complete`,
  ];

  if (summary.verification.total > 0) {
    lines.push(
      `- Final verification: ${summary.verification.completed}/${summary.verification.total} tasks complete`,
    );
  }

  appendRemainingSection(
    lines,
    "Remaining setup and integration work:",
    summary.integration.remainingTasks,
  );
  appendRemainingSection(
    lines,
    "Remaining tree-content work:",
    summary.treeContent.remainingTasks,
  );
  appendRemainingSection(
    lines,
    "Remaining verification work:",
    summary.verification.remainingTasks,
  );

  return `${lines.join("\n")}\n`;
}

export function resolveProgressPath(cwd = process.cwd(), explicitPath) {
  if (explicitPath !== undefined) {
    return resolve(cwd, explicitPath);
  }

  for (const candidate of DEFAULT_PROGRESS_PATHS) {
    const fullPath = resolve(cwd, candidate);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  throw new Error(
    `Could not find progress.md. Checked: ${DEFAULT_PROGRESS_PATHS.join(", ")}`,
  );
}

export function readProgressSummary(options = {}) {
  const progressPath = resolveProgressPath(options.cwd, options.path);
  const markdown = readFileSync(progressPath, "utf-8");
  return summarizeProgressMarkdown(markdown);
}

function main(args = process.argv.slice(2)) {
  const jsonOutput = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");

  if (positional.length > 1) {
    console.error(
      "Usage: summarize-progress.js [progress-file-path] [--json]",
    );
    return 1;
  }

  try {
    const summary = readProgressSummary({
      path: positional[0],
    });

    if (jsonOutput) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      process.stdout.write(formatProgressSummary(summary));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(`Error: ${message}`);
    return 1;
  }

  return 0;
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined
  && import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  process.exitCode = main();
}
