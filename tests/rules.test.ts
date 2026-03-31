import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Repo } from "#src/repo.js";
import {
  evaluateAll,
  framework,
  rootNode,
  agentInstructions,
  members,
  agentIntegration,
  ciValidation,
  populateTree,
} from "#src/rules/index.js";
import {
  useTmpDir,
  makeFramework,
  makeNode,
  makeAgentMd,
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
    expect(result.tasks[0]).toContain(".context-tree/");
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
  it("reports missing AGENT.md", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("missing"))).toBe(true);
  });

  it("reports no markers", () => {
    const tmp = useTmpDir();
    makeAgentMd(tmp.path, { markers: false });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("markers"))).toBe(true);
  });

  it("reports no user content", () => {
    const tmp = useTmpDir();
    makeAgentMd(tmp.path, { markers: true, userContent: false });
    const repo = new Repo(tmp.path);
    const result = agentInstructions.evaluate(repo);
    expect(result.tasks.some((t) => t.toLowerCase().includes("project-specific"))).toBe(true);
  });

  it("passes with markers and user content", () => {
    const tmp = useTmpDir();
    makeAgentMd(tmp.path, { markers: true, userContent: true });
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
      '{"hooks": {"inject-tree-context": true}}',
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
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks[0]).toContain("validation workflow");
    expect(result.tasks[1]).toContain("PR reviews");
    expect(result.tasks[2]).toContain("API secret");
    expect(result.tasks[3]).toContain("CODEOWNERS");
  });

  it("reports workflow without validate or pr-review", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "ci.yml"), "name: CI\non: push\njobs: {}\n");
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(4);
  });

  it("passes validation but reports missing pr-review and codeowners", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "validate.yml"),
      "name: Validate\non: push\njobs:\n  validate:\n    steps:\n      - run: python validate_nodes.py\n",
    );
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks[0]).toContain("PR reviews");
    expect(result.tasks[1]).toContain("API secret");
    expect(result.tasks[2]).toContain("CODEOWNERS");
  });

  it("passes pr-review but reports missing validation and codeowners", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "pr-review.yml"),
      "name: PR Review\non: pull_request\njobs:\n  review:\n    steps:\n      - run: npx tsx .context-tree/run-review.ts\n",
    );
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toContain("validation workflow");
    expect(result.tasks[1]).toContain("CODEOWNERS");
  });

  it("passes with validate and pr-review but reports missing codeowners", () => {
    const tmp = useTmpDir();
    const wfDir = join(tmp.path, ".github", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, "validate.yml"),
      "name: Validate\non: push\njobs:\n  validate:\n    steps:\n      - run: python validate_nodes.py\n",
    );
    writeFileSync(
      join(wfDir, "pr-review.yml"),
      "name: PR Review\non: pull_request\njobs:\n  review:\n    steps:\n      - run: npx tsx .context-tree/run-review.ts\n",
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
      "name: PR Review\non: pull_request\njobs:\n  review:\n    steps:\n      - run: npx tsx .context-tree/run-review.ts\n",
    );
    writeFileSync(
      join(wfDir, "codeowners.yml"),
      "name: Update CODEOWNERS\non: pull_request\njobs:\n  update:\n    steps:\n      - run: npx tsx .context-tree/generate-codeowners.ts\n",
    );
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    expect(result.tasks).toEqual([]);
  });

  it("pr-review task presents numbered options", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    const prTask = result.tasks.find((t) => t.includes("PR review"));
    expect(prTask).toContain("OpenRouter");
    expect(prTask).toContain("Claude API");
    expect(prTask).toContain("Skip");
  });

  it("secret task presents options for gh CLI or manual setup", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = ciValidation.evaluate(repo);
    const secretTask = result.tasks.find((t) => t.includes("API secret"));
    expect(secretTask).toContain("Set it now");
    expect(secretTask).toContain("I'll do it myself");
    expect(secretTask).toContain("gh secret set");
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

  it("first task asks user whether to populate", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = populateTree.evaluate(repo);
    expect(result.tasks[0]).toContain("Yes");
    expect(result.tasks[0]).toContain("No");
  });

  it("includes sub-task parallelization instruction", () => {
    const tmp = useTmpDir();
    const repo = new Repo(tmp.path);
    const result = populateTree.evaluate(repo);
    expect(result.tasks.some((t) => t.includes("sub-task") || t.includes("TaskCreate"))).toBe(true);
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
    makeAgentMd(tmp.path, { markers: true, userContent: true });
    makeMembers(tmp.path, 1);
    mkdirSync(join(tmp.path, ".claude"));
    writeFileSync(
      join(tmp.path, ".claude", "settings.json"),
      '{"hooks": {"inject-tree-context": true}}',
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
