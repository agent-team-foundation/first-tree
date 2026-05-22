import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import type { AgentKind, AgentSpec } from "./runner.js";

const SOURCE_BINDING_BEGIN = "<!-- BEGIN FIRST-TREE-SOURCE-INTEGRATION -->";
const SOURCE_BINDING_END = "<!-- END FIRST-TREE-SOURCE-INTEGRATION -->";
const TREE_REPO_MARKER = "FIRST-TREE-TREE-REPO:";
const SOURCE_BINDING_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const TEMPLATE_FILE_RE = /\.ya?ml$/u;
const TEMPLATE_NAME_ORDER = ["developer", "code-reviewer"] as const;

type ExecutableFinder = (name: string) => string | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readManagedBlock(text: string): string | null {
  const normalized = text.replaceAll("\r\n", "\n");
  const pattern = new RegExp(
    `${escapeForRegExp(SOURCE_BINDING_BEGIN)}[\\s\\S]*?${escapeForRegExp(SOURCE_BINDING_END)}`,
    "mu",
  );
  return normalized.match(pattern)?.[0] ?? null;
}

function readMarker(block: string, marker: string): string | undefined {
  const match = block.match(
    new RegExp(`^${escapeForRegExp(marker)}\\s+(?:\`(.+?)\`|(.+?))\\s*$`, "mu"),
  );
  const value = match?.[1] ?? match?.[2];
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readManagedTreeRepoName(root: string): string | undefined {
  for (const file of SOURCE_BINDING_FILES) {
    const fullPath = join(root, file);
    if (!existsSync(fullPath)) {
      continue;
    }

    const block = readManagedBlock(readFileSync(fullPath, "utf8"));
    if (block === null) {
      continue;
    }

    const treeRepoName = readMarker(block, TREE_REPO_MARKER);
    if (treeRepoName !== undefined) {
      return treeRepoName;
    }
  }

  return undefined;
}

function findUpwardsManagedTreeRepo(startDir: string): {
  bindingRoot: string;
  treeRepoName: string;
} | null {
  let currentDir = resolve(startDir);

  while (true) {
    const treeRepoName = readManagedTreeRepoName(currentDir);
    if (treeRepoName !== undefined) {
      return {
        bindingRoot: currentDir,
        treeRepoName,
      };
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

function pushUniqueExistingDir(dirs: string[], seen: Set<string>, fullPath: string): void {
  if (!existsSync(fullPath) || seen.has(fullPath)) {
    return;
  }

  dirs.push(fullPath);
  seen.add(fullPath);
}

export function resolveAgentTemplateDirs(startDir: string): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  let currentDir = resolve(startDir);

  while (true) {
    pushUniqueExistingDir(dirs, seen, join(currentDir, ".first-tree", "agent-templates"));

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  const binding = findUpwardsManagedTreeRepo(startDir);
  if (binding !== null) {
    pushUniqueExistingDir(dirs, seen, join(binding.bindingRoot, ".first-tree", "agent-templates"));
    pushUniqueExistingDir(
      dirs,
      seen,
      join(
        binding.bindingRoot,
        ".first-tree",
        "tmp",
        binding.treeRepoName,
        ".first-tree",
        "agent-templates",
      ),
    );
    pushUniqueExistingDir(
      dirs,
      seen,
      join(dirname(binding.bindingRoot), binding.treeRepoName, ".first-tree", "agent-templates"),
    );
  }

  return dirs;
}

function normalizeRuntime(value: unknown): {
  kind: AgentKind;
  model?: string;
} | null {
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "codex") {
      return { kind: "codex" };
    }
    if (normalized === "claude" || normalized === "claude-code") {
      return { kind: "claude" };
    }
    return null;
  }

  if (!isRecord(value)) {
    return null;
  }

  const nested = normalizeRuntime(value.kind ?? value.name ?? value.runtime);
  if (nested === null) {
    return null;
  }

  const model =
    typeof value.model === "string" && value.model.trim().length > 0
      ? value.model.trim()
      : undefined;

  return model === undefined ? nested : { ...nested, model };
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (
      typeof rawValue === "string" ||
      typeof rawValue === "number" ||
      typeof rawValue === "boolean"
    ) {
      env[key] = String(rawValue);
    }
  }

  return Object.keys(env).length === 0 ? undefined : env;
}

function readAgentTemplate(path: string): AgentSpec | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const runtime = normalizeRuntime(parsed.runtime);
  if (runtime === null) {
    return null;
  }

  const templateName =
    typeof parsed.name === "string" && parsed.name.trim().length > 0
      ? parsed.name.trim()
      : basename(path).replace(TEMPLATE_FILE_RE, "");
  const prompt =
    typeof parsed.prompt === "string" && parsed.prompt.trim().length > 0
      ? parsed.prompt.trim()
      : undefined;
  const explicitModel =
    typeof parsed.model === "string" && parsed.model.trim().length > 0
      ? parsed.model.trim()
      : undefined;
  const env = normalizeEnv(parsed.env);

  return {
    kind: runtime.kind,
    ...((explicitModel ?? runtime.model) ? { model: explicitModel ?? runtime.model } : {}),
    ...(env ? { env } : {}),
    ...(prompt ? { prompt } : {}),
    templateName,
  };
}

function templateOrder(name: string | undefined): number {
  if (name === undefined) {
    return TEMPLATE_NAME_ORDER.length;
  }

  const normalized = name.trim().toLowerCase();
  const index = TEMPLATE_NAME_ORDER.findIndex((candidate) => candidate === normalized);
  return index >= 0 ? index : TEMPLATE_NAME_ORDER.length;
}

function compareAgentSpecs(left: AgentSpec, right: AgentSpec): number {
  const orderDifference = templateOrder(left.templateName) - templateOrder(right.templateName);
  if (orderDifference !== 0) {
    return orderDifference;
  }

  const leftName = left.templateName ?? left.kind;
  const rightName = right.templateName ?? right.kind;
  return leftName.localeCompare(rightName);
}

export function loadAgentTemplateSpecs(
  startDir: string,
  executableFinder: ExecutableFinder,
): AgentSpec[] {
  const specs: AgentSpec[] = [];
  const seenTemplateNames = new Set<string>();

  for (const dir of resolveAgentTemplateDirs(startDir)) {
    const files = readdirSync(dir)
      .filter((entry) => TEMPLATE_FILE_RE.test(entry))
      .sort((left, right) => left.localeCompare(right));

    for (const file of files) {
      const spec = readAgentTemplate(join(dir, file));
      if (spec === null) {
        continue;
      }
      if (executableFinder(spec.kind) === null) {
        continue;
      }

      const dedupeKey = spec.templateName ?? file;
      if (seenTemplateNames.has(dedupeKey)) {
        continue;
      }

      seenTemplateNames.add(dedupeKey);
      specs.push(spec);
    }
  }

  return specs.sort(compareAgentSpecs);
}
