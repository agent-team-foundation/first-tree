import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";
export const CODEX_CONFIG_PATH = ".codex/config.toml";
export const CODEX_HOOKS_PATH = ".codex/hooks.json";
export const INJECT_CONTEXT_COMMAND = "npx -p first-tree first-tree tree inject-context";

const CODEX_SESSION_START_MATCHER = "startup|resume";
const CODEX_SESSION_START_STATUS = "Loading First Tree context";

const STALE_INJECT_CONTEXT_PATTERNS = [
  /\.agents\/skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/gu,
  /\.claude\/skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/gu,
  /skills\/first-tree\/assets\/framework\/helpers\/inject-tree-context\.sh/gu,
  /\.context-tree\/helpers\/inject-tree-context\.sh/gu,
  /\.context-tree\/scripts\/inject-tree-context\.sh/gu,
  /\.scripts\/inject-tree-context\.sh/gu,
] as const;

export type AgentConfigAction = "created" | "updated" | "unchanged";

export type AgentContextHookSyncResult = {
  claudeSettings: AgentConfigAction;
  codexConfig: AgentConfigAction;
  codexHooks: AgentConfigAction;
};

export function formatAgentContextHookMessages(result: AgentContextHookSyncResult): string[] {
  const messages: string[] = [];

  if (result.claudeSettings === "created") {
    messages.push("Created `.claude/settings.json` with the first-tree SessionStart hook.");
  } else if (result.claudeSettings === "updated") {
    messages.push("Updated `.claude/settings.json` to use the first-tree SessionStart hook.");
  }

  if (result.codexConfig === "created") {
    messages.push("Created `.codex/config.toml` with `codex_hooks = true`.");
  } else if (result.codexConfig === "updated") {
    messages.push("Updated `.codex/config.toml` to enable `codex_hooks`.");
  }

  if (result.codexHooks === "created") {
    messages.push("Created `.codex/hooks.json` with the first-tree `SessionStart` hook.");
  } else if (result.codexHooks === "updated") {
    messages.push("Updated `.codex/hooks.json` to use the first-tree `SessionStart` hook.");
  }

  return messages;
}

export function ensureAgentContextHooks(targetRoot: string): AgentContextHookSyncResult {
  return {
    claudeSettings: writeManagedTextFile(
      join(targetRoot, CLAUDE_SETTINGS_PATH),
      buildClaudeSettingsDocument,
    ),
    codexConfig: writeManagedTextFile(
      join(targetRoot, CODEX_CONFIG_PATH),
      buildCodexConfigDocument,
    ),
    codexHooks: writeManagedTextFile(join(targetRoot, CODEX_HOOKS_PATH), buildCodexHooksDocument),
  };
}

function writeManagedTextFile(
  fullPath: string,
  builder: (current: string | null) => string,
): AgentConfigAction {
  const current = existsSync(fullPath) ? normalizeText(readFileSync(fullPath, "utf-8")) : null;
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
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];

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
  if (current === null || current.trim().length === 0) {
    return "[features]\ncodex_hooks = true\n";
  }

  const normalized = normalizeText(current);
  const lines = normalized.split("\n");
  const featuresIndex = lines.findIndex((line) => line.trim() === "[features]");

  if (featuresIndex < 0) {
    return `${normalized.trimEnd()}\n\n[features]\ncodex_hooks = true\n`;
  }

  let sectionEnd = lines.length;
  for (let index = featuresIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("[") && line.endsWith("]")) {
      sectionEnd = index;
      break;
    }
  }

  const codexHooksIndex = lines.findIndex((line, index) => {
    if (index <= featuresIndex || index >= sectionEnd) {
      return false;
    }

    return /^\s*codex_hooks\s*=/.test(line ?? "");
  });

  if (codexHooksIndex >= 0) {
    lines[codexHooksIndex] = "codex_hooks = true";
  } else {
    lines.splice(sectionEnd, 0, "codex_hooks = true");
  }

  return normalizeText(lines.join("\n"));
}

function buildCodexHooksDocument(current: string | null): string {
  const root = readJsonObject(current);
  const hooks = cloneObject(root.hooks);
  const sessionStart = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];

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
): unknown[] {
  const cleanedGroups: unknown[] = [];

  for (const candidate of groups) {
    if (!isObject(candidate)) {
      cleanedGroups.push(candidate);
      continue;
    }

    const hooks = Array.isArray(candidate.hooks) ? candidate.hooks : [];
    const cleanedHooks = hooks.filter((hook) => !(isObject(hook) && isManagedHook(hook)));

    if (cleanedHooks.length === 0 && hooks.length > 0) {
      continue;
    }

    cleanedGroups.push({
      ...candidate,
      ...(Array.isArray(candidate.hooks) ? { hooks: cleanedHooks } : {}),
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
  return STALE_INJECT_CONTEXT_PATTERNS.some((pattern) => pattern.test(command));
}

function readJsonObject(text: string | null): Record<string, unknown> {
  if (text === null || text.trim().length === 0) {
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
  return `${text.replaceAll("\r\n", "\n").trimEnd()}\n`;
}
