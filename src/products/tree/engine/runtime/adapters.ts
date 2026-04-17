import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  CLAUDE_FRAMEWORK_EXAMPLES_DIR,
  FRAMEWORK_EXAMPLES_DIR,
  LEGACY_REPO_SKILL_EXAMPLES_DIR,
  LEGACY_EXAMPLES_DIR,
} from "#products/tree/engine/runtime/asset-loader.js";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_CONFIG_PATH = ".codex/config.toml";
export const CODEX_HOOKS_PATH = ".codex/hooks.json";
export const INJECT_CONTEXT_COMMAND =
  "npx -p first-tree first-tree inject-context --skip-version-check";

const CODEX_SESSION_START_MATCHER = "startup|resume";
const CODEX_SESSION_START_STATUS = "Loading First Tree context";

const STALE_INJECT_CONTEXT_PATTERNS = [
  /\.agents\/skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/g,
  /\.claude\/skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/g,
  /skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/g,
  /\.context-tree\/helpers\/inject-tree-context\.sh/g,
  /\.context-tree\/scripts\/inject-tree-context\.sh/g,
  /\.scripts\/inject-tree-context\.sh/g,
];

export type AgentConfigAction = "created" | "updated" | "unchanged";
export type AgentConfigHealth = "current" | "missing" | "stale";

export interface AgentContextHookSyncResult {
  claudeSettings: AgentConfigAction;
  codexConfig: AgentConfigAction;
  codexHooks: AgentConfigAction;
}

export interface AgentContextHookHealth {
  claudeSettings: AgentConfigHealth;
  codexConfig: AgentConfigHealth;
  codexHooks: AgentConfigHealth;
}

export interface AgentContextHookFileReport {
  id: keyof AgentContextHookHealth;
  path: string;
  status: AgentConfigHealth;
  summary: string;
}

export interface AgentContextHookReport {
  overall: "current" | "drifted";
  files: AgentContextHookFileReport[];
  health: AgentContextHookHealth;
  repairHint: string;
}

const AGENT_CONTEXT_REPAIR_HINT =
  "Repair with a mutating first-tree command such as `first-tree upgrade`, `first-tree bind`, `first-tree init`, `first-tree workspace sync`, or `first-tree publish`.";

export function formatAgentContextHookMessages(
  result: AgentContextHookSyncResult,
): string[] {
  const messages: string[] = [];
  if (result.claudeSettings === "created") {
    messages.push(
      "Created `.claude/settings.json` with the first-tree SessionStart hook.",
    );
  } else if (result.claudeSettings === "updated") {
    messages.push(
      "Updated `.claude/settings.json` to use the first-tree SessionStart hook.",
    );
  }

  if (result.codexConfig === "created") {
    messages.push("Created `.codex/config.toml` with `codex_hooks = true`.");
  } else if (result.codexConfig === "updated") {
    messages.push("Updated `.codex/config.toml` to enable `codex_hooks`.");
  }

  if (result.codexHooks === "created") {
    messages.push(
      "Created `.codex/hooks.json` with the first-tree `SessionStart` hook.",
    );
  } else if (result.codexHooks === "updated") {
    messages.push(
      "Updated `.codex/hooks.json` to use the first-tree `SessionStart` hook.",
    );
  }

  return messages;
}

export function claudeCodeExampleCandidates(): string[] {
  return [
    join(CLAUDE_FRAMEWORK_EXAMPLES_DIR, "claude-code"),
    join(FRAMEWORK_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_REPO_SKILL_EXAMPLES_DIR, "claude-code"),
    join(LEGACY_EXAMPLES_DIR, "claude-code"),
  ];
}

export function codexExampleCandidates(): string[] {
  return [
    join(FRAMEWORK_EXAMPLES_DIR, "codex"),
    join(LEGACY_REPO_SKILL_EXAMPLES_DIR, "codex"),
    join(LEGACY_EXAMPLES_DIR, "codex"),
  ];
}

export function injectTreeContextHint(): string {
  return INJECT_CONTEXT_COMMAND;
}

export function inspectAgentContextHooks(targetRoot: string): AgentContextHookHealth {
  return inspectAgentContextHookReport(targetRoot).health;
}

export function inspectAgentContextHookReport(
  targetRoot: string,
): AgentContextHookReport {
  const health: AgentContextHookHealth = {
    claudeSettings: inspectClaudeSettingsHealth(targetRoot),
    codexConfig: inspectCodexConfigHealth(targetRoot),
    codexHooks: inspectCodexHooksHealth(targetRoot),
  };

  const files: AgentContextHookFileReport[] = [
    buildAgentContextHookFileReport("claudeSettings", CLAUDE_SETTINGS_PATH, health.claudeSettings),
    buildAgentContextHookFileReport("codexConfig", CODEX_CONFIG_PATH, health.codexConfig),
    buildAgentContextHookFileReport("codexHooks", CODEX_HOOKS_PATH, health.codexHooks),
  ];

  return {
    overall: files.every((file) => file.status === "current") ? "current" : "drifted",
    files,
    health,
    repairHint: AGENT_CONTEXT_REPAIR_HINT,
  };
}

export function formatAgentContextHookDriftMessages(
  report: AgentContextHookReport,
): string[] {
  return report.files
    .filter((file) => file.status !== "current")
    .map((file) => `\`${file.path}\`: ${file.status} — ${file.summary}`);
}

export function ensureAgentContextHooks(
  targetRoot: string,
): AgentContextHookSyncResult {
  return {
    claudeSettings: writeManagedTextFile(
      join(targetRoot, CLAUDE_SETTINGS_PATH),
      buildClaudeSettingsDocument,
    ),
    codexConfig: writeManagedTextFile(
      join(targetRoot, CODEX_CONFIG_PATH),
      buildCodexConfigDocument,
    ),
    codexHooks: writeManagedTextFile(
      join(targetRoot, CODEX_HOOKS_PATH),
      buildCodexHooksDocument,
    ),
  };
}

/**
 * Backward-compatible wrapper kept for older call sites and tests that only
 * reason about the Claude Code settings file.
 */
export function refreshInjectContextHook(
  targetRoot: string,
): "updated" | "unchanged" {
  const fullPath = join(targetRoot, CLAUDE_SETTINGS_PATH);
  if (!existsSync(fullPath)) {
    return "unchanged";
  }

  const original = readFileSync(fullPath, "utf-8");
  let updated = original;
  for (const pattern of STALE_INJECT_CONTEXT_PATTERNS) {
    updated = updated.replace(pattern, INJECT_CONTEXT_COMMAND);
  }
  updated = updated.replace(
    /("command"\s*:\s*")(?:\.\/)?scripts\/inject-tree-context\.sh(")/g,
    `$1${INJECT_CONTEXT_COMMAND}$2`,
  );
  updated = updated.replace(
    /\.\/(npx -p first-tree first-tree inject-context --skip-version-check)/g,
    "$1",
  );

  if (updated === original) {
    return "unchanged";
  }

  writeFileSync(fullPath, updated);
  return "updated";
}

function inspectClaudeSettingsHealth(targetRoot: string): AgentConfigHealth {
  const fullPath = join(targetRoot, CLAUDE_SETTINGS_PATH);
  if (!existsSync(fullPath)) {
    return "missing";
  }

  try {
    const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as unknown;
    const root = isObject(parsed) ? parsed : {};
    const hooks = cloneObject(root.hooks);
    const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    let hasCurrent = false;
    for (const group of sessionStart) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        continue;
      }
      for (const hook of group.hooks) {
        if (!isObject(hook) || hook.type !== "command" || typeof hook.command !== "string") {
          continue;
        }
        if (hook.command === INJECT_CONTEXT_COMMAND) {
          hasCurrent = true;
          continue;
        }
        if (matchesLegacyHookPattern(hook.command)) {
          return "stale";
        }
      }
    }
    return hasCurrent ? "current" : "stale";
  } catch {
    return "stale";
  }
}

function inspectCodexConfigHealth(targetRoot: string): AgentConfigHealth {
  const fullPath = join(targetRoot, CODEX_CONFIG_PATH);
  if (!existsSync(fullPath)) {
    return "missing";
  }
  const current = normalizeText(readFileSync(fullPath, "utf-8"));
  const expected = normalizeText(buildCodexConfigDocument(current));
  return current === expected ? "current" : "stale";
}

function inspectCodexHooksHealth(targetRoot: string): AgentConfigHealth {
  const fullPath = join(targetRoot, CODEX_HOOKS_PATH);
  if (!existsSync(fullPath)) {
    return "missing";
  }

  try {
    const parsed = JSON.parse(readFileSync(fullPath, "utf-8")) as unknown;
    const root = isObject(parsed) ? parsed : {};
    const hooks = cloneObject(root.hooks);
    const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
    for (const group of sessionStart) {
      if (
        !isObject(group)
        || group.matcher !== CODEX_SESSION_START_MATCHER
        || !Array.isArray(group.hooks)
      ) {
        continue;
      }
      for (const hook of group.hooks) {
        if (
          isObject(hook)
          && hook.type === "command"
          && hook.command === INJECT_CONTEXT_COMMAND
        ) {
          return "current";
        }
      }
    }
    return "stale";
  } catch {
    return "stale";
  }
}

function buildAgentContextHookFileReport(
  id: keyof AgentContextHookHealth,
  path: string,
  status: AgentConfigHealth,
): AgentContextHookFileReport {
  switch (id) {
    case "claudeSettings":
      return {
        id,
        path,
        status,
        summary: status === "current"
          ? "Claude Code SessionStart hook is current."
          : status === "missing"
          ? "Missing the managed Claude Code SessionStart hook file."
          : "Does not point at the managed first-tree SessionStart hook.",
      };
    case "codexConfig":
      return {
        id,
        path,
        status,
        summary: status === "current"
          ? "Codex project config enables `codex_hooks`."
          : status === "missing"
          ? "Missing the managed Codex project config file."
          : "Does not enable `codex_hooks = true` for project-scoped hooks.",
      };
    case "codexHooks":
      return {
        id,
        path,
        status,
        summary: status === "current"
          ? "Codex hooks file contains the managed SessionStart hook."
          : status === "missing"
          ? "Missing the managed Codex hooks file."
          : "Does not contain the managed first-tree SessionStart hook.",
      };
  }
}

function writeManagedTextFile(
  fullPath: string,
  builder: (current: string | null) => string,
): AgentConfigAction {
  const current = existsSync(fullPath)
    ? normalizeText(readFileSync(fullPath, "utf-8"))
    : null;
  const next = normalizeText(builder(current));
  if (current === next) {
    return "unchanged";
  }
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, next);
  return current === null ? "created" : "updated";
}

function buildClaudeSettingsDocument(current: string | null): string {
  const root = readJsonObject(current);
  const hooks = cloneObject(root.hooks);
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart
    : [];

  hooks.SessionStart = [
    ...stripManagedHooks(sessionStart, isClaudeManagedHook),
    {
      hooks: [
        {
          type: "command",
          command: INJECT_CONTEXT_COMMAND,
        },
      ],
    },
  ];

  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function buildCodexConfigDocument(current: string | null): string {
  const normalized = normalizeText(current ?? "");
  if (normalized.trim() === "") {
    return "[features]\ncodex_hooks = true\n";
  }

  const featuresMatch = normalized.match(/^\[features\]\s*$/m);
  if (featuresMatch === null || featuresMatch.index === undefined) {
    return `${normalized.trimEnd()}\n\n[features]\ncodex_hooks = true\n`;
  }

  const sectionStart = featuresMatch.index + featuresMatch[0].length;
  const rest = normalized.slice(sectionStart);
  const nextSectionOffset = rest.search(/^\[[^\]]+\]\s*$/m);
  const sectionEnd = nextSectionOffset >= 0
    ? sectionStart + nextSectionOffset
    : normalized.length;
  const before = normalized.slice(0, sectionStart);
  const body = normalized.slice(sectionStart, sectionEnd);
  const after = normalized.slice(sectionEnd);

  if (/^\s*codex_hooks\s*=\s*true\s*$/m.test(body)) {
    return normalized;
  }

  if (/^\s*codex_hooks\s*=\s*false\s*$/m.test(body)) {
    return `${before}${body.replace(/^\s*codex_hooks\s*=\s*false\s*$/m, "codex_hooks = true")}${after}`;
  }

  const trimmedBody = body.trimEnd();
  const nextBody = trimmedBody === ""
    ? "\ncodex_hooks = true\n"
    : `${trimmedBody}\ncodex_hooks = true\n`;
  return `${before}${nextBody}${after.replace(/^\n*/, "\n")}`;
}

function buildCodexHooksDocument(current: string | null): string {
  const root = readJsonObject(current);
  const hooks = cloneObject(root.hooks);
  const sessionStart = Array.isArray(hooks.SessionStart)
    ? hooks.SessionStart
    : [];

  hooks.SessionStart = [
    ...stripManagedHooks(sessionStart, isCodexManagedHook),
    {
      matcher: CODEX_SESSION_START_MATCHER,
      hooks: [
        {
          type: "command",
          command: INJECT_CONTEXT_COMMAND,
          statusMessage: CODEX_SESSION_START_STATUS,
        },
      ],
    },
  ];

  root.hooks = hooks;
  return `${JSON.stringify(root, null, 2)}\n`;
}

function stripManagedHooks(
  groups: unknown[],
  isManagedHook: (hook: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  const cleanedGroups: Record<string, unknown>[] = [];

  for (const candidate of groups) {
    if (!isObject(candidate)) {
      continue;
    }

    const hooks = Array.isArray(candidate.hooks) ? candidate.hooks : [];
    const cleanedHooks = hooks.filter((hook) =>
      !(isObject(hook) && isManagedHook(hook))
    );

    if (cleanedHooks.length === 0) {
      continue;
    }

    cleanedGroups.push({
      ...candidate,
      hooks: cleanedHooks,
    });
  }

  return cleanedGroups;
}

function isClaudeManagedHook(hook: Record<string, unknown>): boolean {
  if (hook.type !== "command" || typeof hook.command !== "string") {
    return false;
  }
  return hook.command === INJECT_CONTEXT_COMMAND || matchesLegacyHookPattern(hook.command);
}

function isCodexManagedHook(hook: Record<string, unknown>): boolean {
  return hook.type === "command" && hook.command === INJECT_CONTEXT_COMMAND;
}

function matchesLegacyHookPattern(command: string): boolean {
  if (command === INJECT_CONTEXT_COMMAND || command === `./${INJECT_CONTEXT_COMMAND}`) {
    return true;
  }
  return STALE_INJECT_CONTEXT_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(command);
  })
    || /(?:\.\/)?scripts\/inject-tree-context\.sh/.test(command);
}

function readJsonObject(text: string | null): Record<string, unknown> {
  if (text === null) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function cloneObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? { ...value } : {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeText(text: string): string {
  return ensureTrailingNewline(text.replaceAll("\r\n", "\n"));
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Refresh any `.github/workflows/{validate,pr-review,codeowners}.yml` files
 * in the user repo by overwriting them with the bundled workflow templates.
 * Only existing files are overwritten — missing workflows stay missing
 * (the user opted out of them, or hasn't installed them yet).
 *
 * Returns the list of workflow filenames that were overwritten.
 */
export function refreshShippedWorkflows(
  targetRoot: string,
  bundledWorkflowsDir: string,
): string[] {
  const updated: string[] = [];
  const shipped = ["validate.yml", "pr-review.yml", "codeowners.yml"];
  for (const filename of shipped) {
    const targetPath = join(targetRoot, ".github", "workflows", filename);
    if (!existsSync(targetPath)) continue;
    const sourcePath = join(bundledWorkflowsDir, filename);
    if (!existsSync(sourcePath)) continue;
    copyFileSync(sourcePath, targetPath);
    updated.push(filename);
  }
  return updated;
}
