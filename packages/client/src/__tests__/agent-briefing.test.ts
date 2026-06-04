import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BuildAgentBriefingOptions,
  buildAgentBriefing,
  FIRST_TREE_FAMILY_SKILL_NAMES,
} from "../runtime/agent-briefing.js";
import type { PredeclaredSourceRepo } from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { AgentIdentity } from "../runtime/handler.js";

// Pin the CLI binding to the prod identity so `${bin}` interpolations in
// the rendered briefing match the literals these tests assert against.
beforeAll(() => {
  setCliBinding({ binName: "first-tree", packageName: "first-tree" });
});

const AGENT_HOME = "/var/lib/agent-hub/workspaces/test-agent";

function makeIdentity(overrides?: Partial<AgentIdentity>): AgentIdentity {
  return {
    agentId: "test-agent",
    inboxId: "inbox-test-agent",
    displayName: "Test Agent",
    type: "agent",
    visibility: "organization",
    delegateMention: null,
    metadata: {},
    ...overrides,
  };
}

function makeOpts(overrides?: Partial<BuildAgentBriefingOptions>): BuildAgentBriefingOptions {
  return {
    identity: makeIdentity(),
    payload: null,
    chatContext: undefined,
    workspacePath: AGENT_HOME,
    sourceRepos: [],
    contextTreePath: null,
    ...overrides,
  };
}

describe("buildAgentBriefing — top-level structure & section order", () => {
  it("emits sections in stable→volatile order with the per-chat block last", () => {
    // Tree-bound + chat-context-bearing case so every header in the
    // expected order list is present; tree-less / no-chat-context cases
    // are exercised in their dedicated describe blocks below.
    const briefing = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/var/lib/context-trees/example",
        chatContext: {
          chatId: "chat-1",
          title: "ship redesign",
          topic: "ship redesign",
          participants: [{ name: "alice", displayName: "Alice", type: "human" }],
        },
      }),
    );

    // Per-agent header ordering invariant: every # / ## that is part of the
    // briefing skeleton must appear in this order, with the per-chat
    // `## Current Chat Context` block at the bottom so the prompt cache
    // stays warm across sibling chats.
    const expectedOrder = [
      "# Identity",
      "# Working in First Tree",
      "## Working Directory",
      "## Worktrees",
      "## Communication",
      "## Workspace Collaboration",
      "## Asking Humans",
      "## Chat Topic",
      "## CLI Overview",
      "# Context Tree",
      "## Core Model",
      "## Reading the Tree",
      "## Writing the Tree",
      "## Tree Location",
      "# Skills",
      "## First Tree Family",
      "## Current Chat Context",
    ];
    let last = -1;
    for (const header of expectedOrder) {
      // First section's header sits at offset 0 (no preceding newline),
      // every subsequent header sits after a `\n\n`. Search either way.
      const idx =
        last < 0 && briefing.startsWith(`${header}\n`) ? 0 : briefing.indexOf(`\n${header}\n`, Math.max(last, 0));
      expect(idx, `header "${header}" missing or out of order`).toBeGreaterThan(last);
      last = idx;
    }
  });

  it("renders identity as personal-assistant when visibility=private", () => {
    const briefing = buildAgentBriefing(
      makeOpts({ identity: makeIdentity({ visibility: "private", displayName: "Aly" }) }),
    );
    expect(briefing).toContain("# Identity\n\nYou are Aly, a personal assistant agent.");
  });

  it("renders identity as autonomous when visibility=organization", () => {
    const briefing = buildAgentBriefing(
      makeOpts({ identity: makeIdentity({ visibility: "organization", displayName: "Aly" }) }),
    );
    expect(briefing).toContain("# Identity\n\nYou are Aly, an autonomous agent.");
  });

  it("emits `## Agent-Specific Prompt` only when payload.prompt.append is non-empty", () => {
    // No payload → block omitted.
    expect(buildAgentBriefing(makeOpts({ payload: null }))).not.toContain("## Agent-Specific Prompt");

    // Empty / whitespace-only append → block omitted.
    const emptyPayload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: "   \n  " },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "" as const,
    };
    expect(buildAgentBriefing(makeOpts({ payload: emptyPayload }))).not.toContain("## Agent-Specific Prompt");

    // Real content → block emitted with the trimmed payload text.
    const realPayload = { ...emptyPayload, prompt: { append: "Follow the local implementation plan." } };
    const briefing = buildAgentBriefing(makeOpts({ payload: realPayload }));
    expect(briefing).toContain("## Agent-Specific Prompt\n\nFollow the local implementation plan.");
  });
});

describe("buildAgentBriefing — # Working in First Tree subsections", () => {
  it("emits the runtime intro block with final-text contract, silent-turn, Issue #389", () => {
    const briefing = buildAgentBriefing(makeOpts());

    // Final-text contract (load-bearing for the result-sink + agent↔agent
    // echo-loop prevention path).
    expect(briefing).toContain("human observers");
    expect(briefing).toContain("does NOT wake other agents");
    expect(briefing).toContain("first-tree chat send <name>");

    // Silent-turn protocol — pairs with result-sink's empty-output guard.
    expect(briefing).toContain("Stay silent when you have nothing to add");
    expect(briefing).toContain("If you have nothing new for the recipient, output nothing");

    // Issue #389: pin the anti-double-encode rule.
    expect(briefing).toContain("Content rules (Issue #389)");
    expect(briefing).toContain("JSON.stringify");
  });

  it("interpolates the agent home into the Working Directory block", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## Working Directory");
    expect(briefing).toContain(`Your fixed working directory is \`${AGENT_HOME}\`.`);
    expect(briefing).toContain("absolute");
    expect(briefing).toContain("persistent state");
  });

  it("emits the Worktrees block (on-demand convention) regardless of source repos presence", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## Worktrees");
    expect(briefing).toContain("No worktrees are pre-created");
    expect(briefing).toContain("git worktree add");
    // The on-demand path must use the agent home as the prefix; only
    // `<task-name>` / `<new-branch>` are literal placeholders.
    expect(briefing).toContain(`${AGENT_HOME}/worktrees/<task-name>`);
    // No literal `<placeholder>` for the home prefix — LLMs sometimes copy
    // those verbatim.
    expect(briefing).not.toContain("<agent-home>/worktrees/");
  });

  it("renders predeclared source repos with top-level paths and upstream coordinates", () => {
    const sourceRepos: PredeclaredSourceRepo[] = [
      {
        absolutePath: `${AGENT_HOME}/api`,
        url: "git@github.com:example/api.git",
        ref: "main",
        branch: "session/test-agent",
      },
      {
        absolutePath: `${AGENT_HOME}/web`,
        url: "git@github.com:example/web.git",
      },
    ];
    const briefing = buildAgentBriefing(makeOpts({ sourceRepos }));

    expect(briefing).toContain("## Source Repositories");
    // Top-level paths — no `worktrees/` prefix.
    expect(briefing).toContain(`\`${AGENT_HOME}/api\``);
    expect(briefing).not.toContain(`\`${AGENT_HOME}/worktrees/api\``);
    expect(briefing).toContain("url=git@github.com:example/api.git");
    expect(briefing).toContain("ref=main");
    expect(briefing).toContain("branch=session/test-agent");
    expect(briefing).toContain(`\`${AGENT_HOME}/web\``);
    // Partial entry — only url should appear, ref/branch parens omitted.
    expect(briefing).not.toMatch(/url=git@github\.com:example\/web\.git,\s*ref=/);
    // Pre-checked-out warning (issue #655) so the agent doesn't reuse the
    // stale hub-session branch for new work.
    expect(briefing).toContain("refreshed during this chat");
    expect(briefing).toContain("git fetch origin");
    expect(briefing).toContain("origin/main");
  });

  it("omits the Source Repositories block when no repos are predeclared", () => {
    const briefing = buildAgentBriefing(makeOpts({ sourceRepos: [] }));
    expect(briefing).not.toContain("## Source Repositories");
    // The Worktrees block still appears though (agent may clone ad-hoc
    // repos that still follow the convention).
    expect(briefing).toContain("## Worktrees");
  });

  it("emits Communication, Workspace Collaboration, Asking Humans, Chat Topic, and CLI Overview subsections", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## Communication");
    expect(briefing).toMatch(/Target is a \*\*human\*\* in this chat/);
    expect(briefing).toMatch(/Target is an \*\*agent\*\* in this chat/);
    expect(briefing).toContain("**Fallback**");

    expect(briefing).toContain("## Workspace Collaboration");
    expect(briefing).toContain("`first-tree` skill");

    expect(briefing).toContain("## Asking Humans");
    expect(briefing).toContain("[pending redesign, 自行判断]");

    expect(briefing).toContain("## Chat Topic");
    expect(briefing).toContain("first-tree chat set-topic");
    // The Chat Topic block points at the Current Chat Context block at the
    // BOTTOM of the briefing (not "above" as in the pre-restructure
    // copy).
    expect(briefing).toContain("at the\nbottom of this briefing");
  });

  it("uses the channel-resolved binary name in the surviving chat-send invariant", () => {
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    try {
      const briefing = buildAgentBriefing(makeOpts());
      expect(briefing).toContain("first-tree-staging chat send");
      // The hardcoded prod name must NOT leak through as a CLI literal
      // (anchor on the literal CLI form `first-tree chat ` only — backtick
      // pointer text mentioning `first-tree` is fine).
      expect(briefing).not.toMatch(/\bfirst-tree chat /);
    } finally {
      setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    }
  });
});

describe("buildAgentBriefing — ## CLI Overview accuracy", () => {
  // Pre-CLI-Overview-rev the table listed `tree read/write/publish` and a
  // `github scan` namespace, both of which don't exist in the registered
  // CLI surface. This suite pins the table against the actually-registered
  // commands so we can't regress.

  it("lists only registered namespaces and never mentions the retired `github scan`", () => {
    const briefing = buildAgentBriefing(makeOpts());

    // Real namespaces — each must appear inside the CLI Overview table.
    const overview = briefing.slice(briefing.indexOf("## CLI Overview"));
    expect(overview).toContain("first-tree chat …");
    expect(overview).toContain("first-tree agent …");
    expect(overview).toContain("first-tree daemon …");
    expect(overview).toContain("first-tree tree …");
    expect(overview).toContain("first-tree org …");

    // Retired / unregistered surface must NOT appear.
    expect(overview).not.toContain("github scan");
  });

  it("lists only real `tree` subcommands — no fictional `read`, `write`, `publish`", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const overview = briefing.slice(briefing.indexOf("## CLI Overview"));

    // Real subcommands (from apps/cli/src/commands/tree/index.ts +
    // tree/migrate.ts which registers as `migrate-to-w1`, not `migrate`).
    expect(overview).toContain("`status`");
    expect(overview).toContain("`init`");
    expect(overview).toContain("`migrate-to-w1`");
    expect(overview).toContain("`verify`");
    expect(overview).toContain("`upgrade`");
    expect(overview).toContain("`inject`");
    expect(overview).toContain("`review`");

    // Fictional subcommands the pre-revision table advertised — must stay
    // gone or agents will burn turns on `unknown command`. `migrate` (the
    // bare form, without the `-to-w1` suffix) was the round-2 regression —
    // pin its absence explicitly so a future edit doesn't drop the suffix.
    expect(overview).not.toMatch(/`tree …`\s+\|[^|]*\bread\b/);
    expect(overview).not.toMatch(/`tree …`\s+\|[^|]*\bwrite\b/);
    expect(overview).not.toMatch(/`tree …`\s+\|[^|]*\bpublish\b/);
    expect(overview).not.toMatch(/`tree …`[^\n]*`migrate`/);
  });
});

describe("buildAgentBriefing — # Context Tree", () => {
  it("emits Core Model / Reading the Tree / Writing the Tree / Tree Location with the tree path interpolated", () => {
    const treePath = "/var/lib/context-trees/example";
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: treePath }));

    expect(briefing).toContain("# Context Tree");
    expect(briefing).toContain("## Core Model");
    expect(briefing).toContain("## Reading the Tree");
    expect(briefing).toContain("## Writing the Tree");
    expect(briefing).toContain("## Tree Location");

    // Reading discipline anchors.
    expect(briefing).toContain("root `NODE.md`");
    expect(briefing).toContain("read tree nodes eagerly, not lazily");
    expect(briefing).toContain("Pick up a new task or requirement");
    expect(briefing).toContain("Task scope shifts mid-conversation");

    // Writing discipline anchors — fresh vs persistent context framing and
    // the tree-PR-before-code-PR ordering rule. The prose wraps the
    // emphasised phrases across lines, so allow either single-line or
    // wrapped forms.
    expect(briefing).toContain("fresh context");
    expect(briefing).toMatch(/\*\*persistent[\s\n]+context\*\*/);
    expect(briefing).toMatch(/tree PR opens first, then the code[\s\n]+PR/);
    expect(briefing).toContain("Implementation-only changes skip the tree");

    // Tree path interpolated under Tree Location.
    expect(briefing).toContain(treePath);
  });

  it("Writing the Tree routing table only references shipped skills", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const writingBlock = briefing.slice(briefing.indexOf("## Writing the Tree"));

    // The three rows must point at shipped skills.
    expect(writingBlock).toContain("`first-tree-write`");
    expect(writingBlock).toContain("`first-tree-sync`");
    expect(writingBlock).toContain("`first-tree-onboarding`");

    // The pre-revision row pointed at the unshipped `first-tree-github-scan`
    // skill payload — must not regress.
    expect(writingBlock).not.toContain("`first-tree-github-scan`");
  });

  it("substitutes a tree-less Tree Location stub that surfaces the gap to a human (no skill names in the stub)", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    // Section header still emitted so the briefing's # Context Tree always
    // contains all four subsections — predictable for the agent and for
    // section-order assertions above.
    expect(briefing).toContain("## Tree Location");
    // Narrow the no-skill-name assertion to just the Tree Location block,
    // not the whole briefing. `## Writing the Tree` is generic guidance
    // and may legitimately name `first-tree-onboarding` in its routing
    // table even for tree-less agents (so the agent knows what skill the
    // routing points at, even if it has to surface the work to a human
    // to actually run it). The Tree Location *stub* is what must not
    // direct a tree-less agent to load an unshipped skill.
    const treeLocationStart = briefing.indexOf("## Tree Location");
    const stub = briefing.slice(treeLocationStart);
    expect(stub).toContain("This agent has no Context Tree bound");
    expect(stub).toContain("surface that\ngap to a human");
    expect(stub).toContain("operator action");
    expect(stub).not.toContain("first-tree-onboarding");
  });
});

describe("buildAgentBriefing — # Skills (Skill Map)", () => {
  it("lists only the shipped First Tree family skills — drift detector against the on-disk skills/ directory", () => {
    // Compute repo root from the test file location, then enumerate
    // `skills/<name>/SKILL.md` payloads. If a future PR adds a skill to
    // `skills/` (or removes one) without updating the Skill Map, this
    // assertion fails so the doc stays honest.
    const testFileDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(testFileDir, "..", "..", "..", "..");
    const skillsDir = join(repoRoot, "skills");

    const shippedSkills = readdirSync(skillsDir).filter((name) => {
      const skillMd = join(skillsDir, name, "SKILL.md");
      try {
        return statSync(skillMd).isFile();
      } catch {
        return false;
      }
    });

    expect(new Set(shippedSkills)).toEqual(new Set(FIRST_TREE_FAMILY_SKILL_NAMES));

    // Use a tree-bound briefing so the First Tree Family map is emitted —
    // the tree-less omission case is exercised by its dedicated test below.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const skillMap = briefing.slice(briefing.indexOf("## First Tree Family"));

    // Every shipped skill must appear; no unshipped names allowed.
    for (const name of shippedSkills) {
      expect(skillMap).toContain(`\`${name}\``);
    }
    // The pre-revision Skill Map advertised three skills the runtime never
    // installs; pin them out so a future edit doesn't regress.
    expect(skillMap).not.toContain("`first-tree-github-scan`");
    expect(skillMap).not.toContain("`attention`");
    expect(skillMap).not.toContain("`github-scan`");
  });

  it("nests `## Team Skills` (per-agent resource skills) under `# Skills` when payload.resourceSkills is non-empty (tree-bound)", () => {
    const payload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: "" },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [
        {
          resourceId: "res-1",
          name: "internal-playbook",
          description: "Team-internal playbook",
          metadata: {},
          body: "# Playbook",
        },
      ],
      reasoningEffort: "" as const,
    };
    const briefing = buildAgentBriefing(makeOpts({ payload, contextTreePath: "/tree" }));

    const skillsSection = briefing.slice(briefing.indexOf("# Skills"));
    expect(skillsSection).toContain("## Team Skills");
    expect(skillsSection).toContain("internal-playbook: Team-internal playbook");
    expect(skillsSection).toContain("## First Tree Family");
    // Team Skills must precede First Tree Family inside the # Skills block.
    expect(skillsSection.indexOf("## Team Skills")).toBeLessThan(skillsSection.indexOf("## First Tree Family"));
  });

  it("omits `## Team Skills` when payload.resourceSkills is empty (First Tree Family is still emitted for tree-bound agents)", () => {
    // Tree-bound agent → First Tree Family is the only entry under # Skills.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const skillsSection = briefing.slice(briefing.indexOf("# Skills"));
    expect(skillsSection).not.toContain("## Team Skills");
    expect(skillsSection).toContain("## First Tree Family");
  });

  it("omits the First Tree Family map for tree-less agents (skills are gated on `installFirstTreeIntegration`)", () => {
    // A no-tree agent's `tree skill install` never runs, so listing the
    // First Tree family would tell it to load skills that the runtime
    // never put on disk. The map must be gated.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    expect(briefing).not.toContain("## First Tree Family");
    // And without Team Skills, the bare `# Skills` umbrella is skipped
    // entirely — a header with no body is just visual noise.
    expect(briefing).not.toMatch(/^# Skills\s*$/m);
  });

  it("keeps the `# Skills` umbrella for tree-less agents that DO have Team Skills (resource skills land regardless)", () => {
    // Resource skills are installed via `materializeResourceSkills`, which
    // runs irrespective of Context Tree binding — so a tree-less agent
    // with team skills configured still needs the `# Skills` header.
    const payload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: "" },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [
        {
          resourceId: "res-1",
          name: "internal-playbook",
          description: "Team-internal playbook",
          metadata: {},
          body: "# Playbook",
        },
      ],
      reasoningEffort: "" as const,
    };
    const briefing = buildAgentBriefing(makeOpts({ payload, contextTreePath: null }));
    expect(briefing).toContain("# Skills");
    expect(briefing).toContain("## Team Skills");
    expect(briefing).toContain("internal-playbook");
    // Still no First Tree Family — those skills aren't installed for
    // tree-less agents.
    expect(briefing).not.toContain("## First Tree Family");
  });
});

describe("buildAgentBriefing — ## Current Chat Context (per-chat tail)", () => {
  it("appends the Current Chat Context block when chatContext is provided", () => {
    const briefing = buildAgentBriefing(
      makeOpts({
        chatContext: {
          chatId: "chat-123",
          title: "ship redesign",
          topic: "ship redesign",
          participants: [
            { name: "alice", displayName: "Alice", type: "human" },
            { name: "bob-bot", displayName: "Bob Bot", type: "agent" },
          ],
        },
      }),
    );
    expect(briefing).toContain("## Current Chat Context");
    expect(briefing).toContain("Chat ID: chat-123");
    expect(briefing).toContain("@alice");
    expect(briefing).toContain("@bob-bot");
  });

  it("omits the Current Chat Context block when chatContext is undefined (degraded fetch)", () => {
    const briefing = buildAgentBriefing(makeOpts({ chatContext: undefined }));
    expect(briefing).not.toContain("## Current Chat Context");
  });
});
