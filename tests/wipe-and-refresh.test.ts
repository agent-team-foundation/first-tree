import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAgentContextHooks,
  inspectAgentContextHooks,
  refreshInjectContextHook,
  refreshShippedWorkflows,
} from "../src/products/tree/engine/runtime/adapters.js";
import { wipeInstalledSkill } from "../src/products/tree/engine/runtime/installer.js";
import { useTmpDir } from "./helpers.js";

describe("wipeInstalledSkill", () => {
  it("removes all known installed-skill paths", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".agents", "skills", "first-tree", "engine"), {
      recursive: true,
    });
    writeFileSync(
      join(tmp.path, ".agents", "skills", "first-tree", "SKILL.md"),
      "stale",
    );
    mkdirSync(join(tmp.path, ".claude", "skills"), { recursive: true });
    symlinkSync(
      "../../.agents/skills/first-tree",
      join(tmp.path, ".claude", "skills", "first-tree"),
    );
    mkdirSync(join(tmp.path, "skills", "first-tree"), { recursive: true });
    writeFileSync(
      join(tmp.path, "skills", "first-tree", "SKILL.md"),
      "legacy",
    );
    mkdirSync(join(tmp.path, ".context-tree"), { recursive: true });
    writeFileSync(join(tmp.path, ".context-tree", "VERSION"), "0.0.1");

    const removed = wipeInstalledSkill(tmp.path);

    expect(removed).toContain(".agents/skills/first-tree");
    expect(removed).toContain(".claude/skills/first-tree");
    expect(removed).toContain("skills/first-tree");
    expect(removed).toContain(".context-tree");
    expect(existsSync(join(tmp.path, ".agents", "skills", "first-tree"))).toBe(
      false,
    );
    expect(existsSync(join(tmp.path, ".claude", "skills", "first-tree"))).toBe(
      false,
    );
    expect(existsSync(join(tmp.path, "skills", "first-tree"))).toBe(false);
    expect(existsSync(join(tmp.path, ".context-tree"))).toBe(false);
  });

  it("returns empty list when nothing is installed", () => {
    const tmp = useTmpDir();
    const removed = wipeInstalledSkill(tmp.path);
    expect(removed).toEqual([]);
  });
});

describe("refreshInjectContextHook", () => {
  it("replaces a stale .agents/.../inject-tree-context.sh hook command", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      ".agents/skills/first-tree/assets/framework/helpers/inject-tree-context.sh",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const result = refreshInjectContextHook(tmp.path);
    expect(result).toBe("updated");
    const updated = readFileSync(
      join(tmp.path, ".claude", "settings.json"),
      "utf-8",
    );
    expect(updated).toContain(
      "npx -p first-tree first-tree inject-context --skip-version-check",
    );
    expect(updated).not.toContain("inject-tree-context.sh");
  });

  it("replaces a stale .context-tree/scripts/inject-tree-context.sh hook command", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: ".context-tree/scripts/inject-tree-context.sh",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const result = refreshInjectContextHook(tmp.path);
    expect(result).toBe("updated");
    const updated = readFileSync(
      join(tmp.path, ".claude", "settings.json"),
      "utf-8",
    );
    expect(updated).toContain(
      "npx -p first-tree first-tree inject-context --skip-version-check",
    );
    expect(updated).not.toContain(".context-tree/scripts/inject-tree-context.sh");
  });

  it("replaces a stale .claude/skills/.../inject-tree-context.sh path with the leading ./ stripped", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "./.claude/skills/first-tree/assets/framework/helpers/inject-tree-context.sh",
                },
              ],
            },
          ],
        },
      }),
    );

    const result = refreshInjectContextHook(tmp.path);
    expect(result).toBe("updated");
    const updated = readFileSync(
      join(tmp.path, ".claude", "settings.json"),
      "utf-8",
    );
    expect(updated).toContain(
      `"command":"npx -p first-tree first-tree inject-context --skip-version-check"`,
    );
    expect(updated).not.toContain("./npx");
  });

  it("replaces a stale scripts/inject-tree-context.sh hook command", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "scripts/inject-tree-context.sh",
                },
              ],
            },
          ],
        },
      }),
    );

    const result = refreshInjectContextHook(tmp.path);
    expect(result).toBe("updated");
    const updated = readFileSync(
      join(tmp.path, ".claude", "settings.json"),
      "utf-8",
    );
    expect(updated).toContain(
      `"command":"npx -p first-tree first-tree inject-context --skip-version-check"`,
    );
  });

  it("returns unchanged when settings.json already uses the CLI command", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "npx -p first-tree first-tree inject-context --skip-version-check",
                },
              ],
            },
          ],
        },
      }),
    );
    expect(refreshInjectContextHook(tmp.path)).toBe("unchanged");
  });

  it("returns unchanged when settings.json is missing", () => {
    const tmp = useTmpDir();
    expect(refreshInjectContextHook(tmp.path)).toBe("unchanged");
  });
});

describe("ensureAgentContextHooks", () => {
  it("creates Claude Code and Codex hook files when they are missing", () => {
    const tmp = useTmpDir();

    const result = ensureAgentContextHooks(tmp.path);

    expect(result).toEqual({
      claudeSettings: "created",
      codexConfig: "created",
      codexHooks: "created",
    });
    expect(
      readFileSync(join(tmp.path, ".claude", "settings.json"), "utf-8"),
    ).toContain("first-tree inject-context");
    expect(
      readFileSync(join(tmp.path, ".codex", "config.toml"), "utf-8"),
    ).toContain("codex_hooks = true");
    expect(
      readFileSync(join(tmp.path, ".codex", "hooks.json"), "utf-8"),
    ).toContain("\"matcher\": \"startup|resume\"");
    expect(inspectAgentContextHooks(tmp.path)).toEqual({
      claudeSettings: "current",
      codexConfig: "current",
      codexHooks: "current",
    });
  });

  it("updates stale Codex files while preserving unrelated configuration", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".codex"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".codex", "config.toml"),
      ['model = "gpt-5.4"', "", "[features]", "codex_hooks = false", ""].join("\n"),
    );
    writeFileSync(
      join(tmp.path, ".codex", "hooks.json"),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                matcher: "Bash",
                hooks: [
                  {
                    type: "command",
                    command: "echo pre-tool",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
    );

    const result = ensureAgentContextHooks(tmp.path);
    const config = readFileSync(join(tmp.path, ".codex", "config.toml"), "utf-8");
    const hooks = readFileSync(join(tmp.path, ".codex", "hooks.json"), "utf-8");

    expect(result.codexConfig).toBe("updated");
    expect(result.codexHooks).toBe("updated");
    expect(config).toContain('model = "gpt-5.4"');
    expect(config).toContain("codex_hooks = true");
    expect(hooks).toContain("\"PreToolUse\"");
    expect(hooks).toContain("\"SessionStart\"");
    expect(hooks).toContain("Loading First Tree context");
  });
});

describe("refreshShippedWorkflows", () => {
  it("overwrites only the shipped workflow files that already exist", () => {
    const tmp = useTmpDir();
    const bundled = useTmpDir();
    mkdirSync(bundled.path, { recursive: true });
    writeFileSync(join(bundled.path, "validate.yml"), "new validate");
    writeFileSync(join(bundled.path, "pr-review.yml"), "new pr-review");
    writeFileSync(join(bundled.path, "codeowners.yml"), "new codeowners");

    mkdirSync(join(tmp.path, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".github", "workflows", "validate.yml"),
      "old validate",
    );
    writeFileSync(
      join(tmp.path, ".github", "workflows", "custom.yml"),
      "user owned",
    );

    const updated = refreshShippedWorkflows(tmp.path, bundled.path);

    expect(updated).toEqual(["validate.yml"]);
    expect(
      readFileSync(
        join(tmp.path, ".github", "workflows", "validate.yml"),
        "utf-8",
      ),
    ).toBe("new validate");
    expect(
      readFileSync(
        join(tmp.path, ".github", "workflows", "custom.yml"),
        "utf-8",
      ),
    ).toBe("user owned");
    expect(
      existsSync(join(tmp.path, ".github", "workflows", "pr-review.yml")),
    ).toBe(false);
  });

  it("returns empty list when no shipped workflows exist in target", () => {
    const tmp = useTmpDir();
    const bundled = useTmpDir();
    mkdirSync(bundled.path, { recursive: true });
    writeFileSync(join(bundled.path, "validate.yml"), "new");

    expect(refreshShippedWorkflows(tmp.path, bundled.path)).toEqual([]);
  });
});
