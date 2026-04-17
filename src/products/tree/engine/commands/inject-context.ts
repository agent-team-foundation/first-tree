import { buildTreeFirstContextBundle } from "#products/tree/engine/runtime/tree-first-context.js";

export const INJECT_CONTEXT_USAGE = `usage: first-tree tree inject-context

Output a SessionStart hook payload that injects tree-first cross-repo context.
When the current working directory is a bound source/workspace root, the
command resolves the canonical tree checkout, reads the tree root NODE.md,
and appends a bindings-derived repo index. Tree repos still work directly.

Intended to be wired into Claude Code and Codex SessionStart hooks. Use
\`--skip-version-check\` (the global flag) to avoid the npm registry check
on every session start.

Options:
  --help         Show this help message
`;

export function runInjectContext(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INJECT_CONTEXT_USAGE);
    return 0;
  }

  const bundle = buildTreeFirstContextBundle(process.cwd());
  if (bundle === null) {
    // Silent no-op: emit empty payload so the hook doesn't fail
    return 0;
  }

  const payload = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: bundle.additionalContext,
    },
  };
  console.log(JSON.stringify(payload));
  return 0;
}
