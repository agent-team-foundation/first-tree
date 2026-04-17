import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#products/tree/engine/repo.js";
import {
  evaluateAll,
  framework,
  rootNode,
  agentInstructions,
  members,
  agentIntegration,
  ciValidation,
  populateTree,
} from "#products/tree/engine/rules/index.js";
import {
  useTmpDir,
  makeFramework,
  makeNode,
  makeAgentsMd,
  makeClaudeMd,
  makeMembers,
} from "./helpers.js";

// --- framework rule ---

describe("framework rule", () => {
  it("reports missing framework", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = framework.evaluate(repo);
    expect(result.group).toBe("Framework");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toContain(".agents/skills/first-tree/");
  });

  it("passes when framework exists", () => {
    const tmp = useTmpDir();
    makeFramework(tmp.path);
    const repo = new Repo(tmp.path);
    const result = framework.evaluate(repo);
    expect(result.tasks).toEqual([]);
  });
});

// --- root_node rule ---

describe("rootNode rule", () => {
  it("reports missing NODE.md", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = rootNode.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("missing"))).toBe(true);
  });

  it("reports no frontmatter", () => {
    const tmp = useTmpDir();
    writeFileSync(join(tmp.path, "NODE.md"), "# No frontmatter\n");
    const repo = new Repo(tmp.path);
    const result = rootNode.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("no frontmatter"))).toBe(true);
  });

  it("reports placeholder title", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: '<YOUR ORG>'\nowners: [alice]\n---\n",
    );
    const repo = new Repo(tmp.path);
    const result = rootNode.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("placeholder title"))).toBe(true);
  });

  it("reports placeholder owners", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: Real Title\nowners: [<your-github>]\n---\n",
    );
    const repo = new Repo(tmp.path);
    const result = rootNode.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("placeholder owners"))).toBe(true);
  });

  it("reports placeholder content", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "NODE.md"),
      "---\ntitle: Real\nowners: [alice]\n---\n<!-- PLACEHOLDER -->\n",
    );
    const repo = new Repo(tmp.path);
    const result = rootNode.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("placeholder content"))).toBe(true);
  });

  it("passes with valid node", () => {
    const tmp = useTmpDir();
    makeNode(tmp.path);
    const repo = new Repo(tmp.path);
    const result = rootNode.evaluate(repo);
    expect(result.tasks).toEqual([]);
  });
});

// --- agent_instructions rule ---

describe("agentInstructions rule", () => {
  it("reports missing AGENTS.md", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("AGENTS.md is missing"))).toBe(true);
  });

  it("reports legacy AGENT.md rename", () => {
    const tmp = useTmpDir();
    makeAgentsMd(tmp.path, { legacyName: true, markers: true, userContent: true });
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("Rename `AGENT.md` to `AGENTS.md`"))).toBe(
      true,
    );
  });

  it("reports duplicate cleanup when both filenames exist", () => {
    const tmp = useTmpDir();
    makeAgentsMd(tmp.path, { markers: true, userContent: true });
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    makeAgentsMd(tmp.path, { legacyName: true, markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("delete the legacy file"))).toBe(true);
  });

  it("reports no markers", () => {
    const tmp = useTmpDir();
    makeAgentsMd(tmp.path, { markers: false });
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("markers"))).toBe(true);
  });

  it("reports no user content", () => {
    const tmp = useTmpDir();
    makeAgentsMd(tmp.path, { markers: true, userContent: false });
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("project-specific"))).toBe(true);
  });

  it("reports duplicate placeholder blocks in AGENTS.md", () => {
    const tmp = useTmpDir();
    writeFileSync(
      join(tmp.path, "AGENTS.md"),
      [
        "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->",
        "framework stuff",
        "<!-- END CONTEXT-TREE FRAMEWORK -->",
        "",
        "# Project-Specific Instructions",
        "",
        "<!-- Add your project-specific agent instructions below this line. -->",
        "",
        "# Project-Specific Instructions",
        "",
        "<!-- Add your project-specific agent instructions below this line. -->",
        "",
      ].join("\n"),
    );
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("duplicate") && t.includes("AGENTS.md"))).toBe(
      true,
    );
  });

  it("reports duplicate placeholder blocks in CLAUDE.md", () => {
    const tmp = useTmpDir();
    makeAgentsMd(tmp.path, { markers: true, userContent: true });
    writeFileSync(
      join(tmp.path, "CLAUDE.md"),
      [
        "<!-- BEGIN CONTEXT-TREE FRAMEWORK -->",
        "framework stuff",
        "<!-- END CONTEXT-TREE FRAMEWORK -->",
        "",
        "# Project-Specific Instructions",
        "",
        "<!-- Add your project-specific agent instructions below this line. -->",
        "",
        "# Project-Specific Instructions",
        "",
        "<!-- Add your project-specific agent instructions below this line. -->",
        "",
      ].join("\n"),
    );
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("duplicate") && t.includes("CLAUDE.md"))).toBe(
      true,
    );
  });

  it("reports missing CLAUDE.md", () => {
    const tmp = useTmpDir();
    makeAgentsMd(tmp.path, { markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("CLAUDE.md is missing"))).toBe(true);
  });

  it("passes with markers and user content", () => {
    const tmp = useTmpDir();
    makeAgentsMd(tmp.path, { markers: true, userContent: true });
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks).toEqual([]);
  });
});

// --- members rule ---

describe("members rule", () => {
  it("reports no members dir", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = members.evaluate(repo);
    expect(result.tasks.length).toBeGreaterThanOrEqual(1);
  });

  it("reports members dir without NODE.md", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, "members"));
    const repo = new Repo(tmp.path);
    const result = members.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("NODE.md"))).toBe(true);
  });

  it("reports no children", () => {
    const tmp = useTmpDir();
    const membersDir = join(tmp.path, "members");
    mkdirSync(membersDir);
    writeFileSync(join(membersDir, "NODE.md"), "---\ntitle: Members\n---\n");
    const repo = new Repo(tmp.path);
    const result = members.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("at least one member"))).toBe(true);
  });

  it("passes with children", () => {
    const tmp = useTmpDir();
    makeMembers(tmp.path, 1);
    const repo = new Repo(tmp.path);
    const result = members.evaluate(repo);
    expect(result.tasks).toEqual([]);
  });
});

// --- agent_integration rule ---

describe("agentIntegration rule", () => {
  it("reports no agent config", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = agentIntegration.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("no agent configuration"))).toBe(true);
  });

  it("reports claude settings without hook", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"));
    writeFileSync(join(tmp.path, ".claude", "settings.json"), "{}");
    const repo = new Repo(tmp.path);
    const result = agentIntegration.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("SessionStart"))).toBe(true);
  });

  it("passes with claude settings and hook", () => {
    const tmp = useTmpDir();
    mkdirSync(join(tmp.path, ".claude"));
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"npx -p first-tree first-tree inject-context --skip-version-check"}]}]}}',
    );
    const repo = new Repo(tmp.path);
    const result = agentIntegration.evaluate(repo);
    expect(result.tasks).toEqual([]);
  });
});

// --- ci_validation rule ---

describe("ciValidation rule", () => {
  it("reports no workflows", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toContain("validation workflow");
    expect(result.tasks[0]).toContain("validate.yml");
    expect(result.tasks[0]).toContain("bundled first-tree workflow templates");
    expect(result.tasks[1]).toContain("CODEOWNERS");
  });

  it("reports workflow without validate or codeowners", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "ci.yml"), "name: CI\non: push\njobs: {}\n");
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(2);
  });

  it("passes validation but reports missing codeowners", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "validate.yml"),
      "name: Validate\non: push\njobs:\n  validate:\n    steps:\n      - run: python validate_nodes.py\n",
    );
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toContain("CODEOWNERS");
  });

  it("ignores pr-review workflow for core onboarding", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "pr-review.yml"),
      "name: PR Review\non: pull_request\njobs:\n  review:\n    steps:\n      - run: npx tsx .agents/skills/first-tree/assets/framework/helpers/run-review.ts\n",
    );
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toContain("validation workflow");
    expect(result.tasks[1]).toContain("CODEOWNERS");
  });

  it("passes with validate and pr-review but still only reports missing codeowners", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "validate.yml"),
      "name: Validate\non: push\njobs:\n  validate:\n    steps:\n      - run: python validate_nodes.py\n",
    );
    writeFileSync(
      join(wfDir, "pr-review.yml"),
      "name: PR Review\non: pull_request\njobs:\n  review:\n    steps:\n      - run: npx tsx .agents/skills/first-tree/assets/framework/helpers/run-review.ts\n",
    );
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toContain("CODEOWNERS");
  });

  it("passes with all three workflows", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "validate.yml"),
      "name: Validate\non: push\njobs:\n  validate:\n    steps:\n      - run: python validate_nodes.py\n",
    );
    writeFileSync(
      join(wfDir, "pr-review.yml"),
      "name: PR Review\non: pull_request\njobs:\n  review:\n    steps:\n      - run: npx tsx .agents/skills/first-tree/assets/framework/helpers/run-review.ts\n",
    );
    writeFileSync(
      join(wfDir, "codeowners.yml"),
      "name: Update CODEOWNERS\non: pull_request\njobs:\n  update:\n    steps:\n      - run: npx tsx .agents/skills/first-tree/assets/framework/helpers/generate-codeowners.ts\n",
    );
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toEqual([]);
  });

  it("does not ask init users to configure PR reviews or API secrets", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks.join("\n")).not.toContain("PR review");
    expect(result.tasks.join("\n")).not.toContain("API secret");
    expect(result.tasks.join("\n")).not.toContain("OpenRouter");
    expect(result.tasks.join("\n")).not.toContain("Claude API");
    expect(result.tasks.join("\n")).not.toContain("gh secret set");
  });
});

// --- populateTree rule ---

describe("populateTree rule", () => {
  it("always produces tasks", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = populateTree.evaluate(repo);
    expect(result.group).toBe("Populate Tree");
    expect(result.order).toBe(7);
    expect(result.tasks.length).toBeGreaterThanOrEqual(4);
  });

  it("starts with a progress checkpoint before asking whether to populate", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = populateTree.evaluate(repo);
    expect(result.tasks[0]).toContain("progress.md");
    expect(result.tasks[0]).toContain("baseline coverage");
    expect(result.tasks[1]).toContain("Yes");
    expect(result.tasks[1]).toContain("No");
  });

  it("includes wave-based sub-task parallelization instruction", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = populateTree.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("wave"))).toBe(true);
    expect(result.tasks.some((t) => t.includes("sub-task") || t.includes("TaskCreate"))).toBe(true);
    expect(result.tasks.some((t) => t.includes("root `NODE.md`"))).toBe(true);
  });
});

// --- evaluateAll ---

describe("evaluateAll", () => {
  it("returns sorted groups", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const groups = evaluateAll(repo);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const orders = groups.map((g) => g.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("excludes empty groups", () => {
    const tmp = useTmpDir();
    makeFramework(tmp.path);
    makeNode(tmp.path);
    makeAgentsMd(tmp.path, { markers: true, userContent: true });
    makeClaudeMd(tmp.path, { markers: true, userContent: true });
    makeMembers(tmp.path, 1);
    mkdirSync(join(tmp.path, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"npx -p first-tree first-tree inject-context --skip-version-check"}]}]}}',
    );
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "validate.yml"),
      "steps:\n  - run: validate_nodes\n  - run: run-review\n  - run: generate-codeowners\n",
    );
    const repo = new Repo(tmp.path);
    const groups = evaluateAll(repo);
    for (const g of groups) {
      expect(g.tasks.length).toBeGreaterThan(0);
    }
  });

  it("includes populate tree group", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const groups = evaluateAll(repo);
    expect(groups.some((g) => g.group === "Populate Tree")).toBe(true);
  });
});
