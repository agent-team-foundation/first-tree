import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const INJECT_CONTEXT_USAGE = `usage: first-tree inject-context

Output a Claude Code SessionStart hook payload that injects the root NODE.md
content as additional session context. Reads NODE.md from the current working
directory.

Intended to be wired into \`.claude/settings.json\` as the SessionStart hook
command. Use \`--skip-version-check\` (the global flag) to avoid the npm
registry check on every session start.

Options:
  --help         Show this help message
`;

export function runInjectContext(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INJECT_CONTEXT_USAGE);
    return 0;
  }

  const nodeMdPath = join(process.cwd(), "NODE.md");
  if (!existsSync(nodeMdPath)) {
    // Silent no-op: emit empty payload so the hook doesn't fail
    return 0;
  }

  const content = readFileSync(nodeMdPath, "utf-8");
  const payload = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: content,
    },
  };
  console.log(JSON.stringify(payload));
  return 0;
}
