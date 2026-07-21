import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../../../..");
const parser = join(repoRoot, "skills", "context-tree-review", "scripts", "parse-repair-scope.mjs");
const tempDirs: string[] = [];

function runParser(body: string) {
  const dir = mkdtempSync(join(tmpdir(), "context-review-scope-"));
  tempDirs.push(dir);
  const bodyFile = join(dir, "body.md");
  writeFileSync(bodyFile, body);
  return spawnSync(process.execPath, [parser, bodyFile], { encoding: "utf8" });
}

function bodyWith(items: string, prefix = "Summary\n\n", suffix = "\n\n## Verification\n\nPassed.\n") {
  return `${prefix}## Context Tree Review

The PR author authorizes the configured Context Tree Reviewer to repair only the exact files below.

### Repair scope

${items}${suffix}`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Context Tree Review repair-scope parser", () => {
  it("accepts exactly one sorted exact-file consent block", () => {
    const result = runParser(bodyWith("- `domain/a.md`\n- `domain/b.md`"));

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ repairScope: ["domain/a.md", "domain/b.md"] });
    expect(result.stderr).toBe("");
  });

  it.each([
    ["missing block", "Summary only"],
    ["duplicate block", `${bodyWith("- `domain/a.md`")}\n${bodyWith("- `domain/a.md`", "", "")}`],
    ["changed consent", bodyWith("- `domain/a.md`").replace("authorizes", "permits")],
    ["extra block prose", bodyWith("Explanation\n\n- `domain/a.md`")],
    [
      "interleaved prose",
      bodyWith("- `domain/a.md`").replace("\n\n### Repair scope", "\n\nExtra.\n\n### Repair scope"),
    ],
    ["unsorted paths", bodyWith("- `domain/b.md`\n- `domain/a.md`")],
    ["duplicate paths", bodyWith("- `domain/a.md`\n- `domain/a.md`")],
    ["glob", bodyWith("- `domain/*.md`")],
    ["directory shorthand", bodyWith("- `domain/`")],
    ["absolute path", bodyWith("- `/domain/a.md`")],
    ["traversal", bodyWith("- `domain/../a.md`")],
    ["protected GitHub path", bodyWith("- `.github/workflows/verify.yml`")],
    ["protected CODEOWNERS", bodyWith("- `CODEOWNERS`")],
    ["non-code-span entry", bodyWith("- domain/a.md")],
    ["HTML-comment authorization", `<!--\n${bodyWith("- `domain/a.md`", "", "")}\n-->`],
    [
      "hidden HTML-comment duplicate",
      `${bodyWith("- `domain/a.md`")}\n<!--\n${bodyWith("- `domain/b.md`", "", "")}\n-->`,
    ],
    ["closed backtick fence", `\`\`\`markdown\n${bodyWith("- `domain/a.md`", "", "")}\n\`\`\``],
    ["unclosed backtick fence", `\`\`\`markdown\n${bodyWith("- `domain/a.md`", "", "")}`],
    ["tilde fence", `~~~~markdown\n${bodyWith("- `domain/a.md`", "", "")}\n~~~~`],
  ])("fails closed for %s", (_name, body) => {
    const result = runParser(body);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("invalid Context Tree repair scope:");
  });
});
