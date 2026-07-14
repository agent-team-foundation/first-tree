import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BuildAgentBriefingOptions,
  buildAgentBriefing,
  FIRST_TREE_FAMILY_SKILL_NAMES,
  resolveAgentBriefingTemplatePath,
} from "../runtime/agent-briefing.js";
import type { PredeclaredSourceRepo } from "../runtime/bootstrap.js";
import { setCliBinding } from "../runtime/cli-binding.js";
import type { AgentIdentity } from "../runtime/handler.js";

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
    workspacePath: AGENT_HOME,
    sourceRepos: [],
    contextTreePath: null,
    ...overrides,
  };
}

function topLevelSection(briefing: string, heading: string): string {
  const marker = `\n${heading}\n`;
  const start = briefing.indexOf(marker);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const contentStart = start + 1;
  const next = briefing.slice(contentStart + heading.length + 1).search(/\n# [^\n]+\n/u);
  if (next === -1) return briefing.slice(contentStart);
  return briefing.slice(contentStart, contentStart + heading.length + 1 + next);
}

function lineCount(text: string): number {
  return text.split(/\r?\n/u).length;
}

describe("buildAgentBriefing — generated skeleton", () => {
  it("renders through the checked-in EJS template and ends with a newline", () => {
    const templatePath = resolveAgentBriefingTemplatePath();

    expect(templatePath).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "templates", "agent-briefing.ejs"),
    );

    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("# Identity\n\nYou are Test Agent, an autonomous agent.");
    expect(briefing.endsWith("\n")).toBe(true);
  });

  it("keeps top-level section order stable and excludes per-chat Current Chat Context", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const expectedOrder = [
      "# Identity",
      "# Working in First Tree (First Tree Managed)",
      "# Context Tree (First Tree Managed)",
      "# Skills (First Tree Managed)",
    ];

    let last = -1;
    for (const heading of expectedOrder) {
      const idx = briefing.indexOf(`\n${heading}\n`, Math.max(last, 0));
      expect(idx, `${heading} missing or out of order`).toBeGreaterThan(last);
      last = idx;
    }

    expect(briefing).not.toContain("## Current Chat Context");
    expect(briefing).not.toContain("Chat ID:");
    expect(briefing).not.toContain("Participants:");
  });

  it("opens with generated provenance and prompt edit boundaries", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing.startsWith("<!--")).toBe(true);
    expect(briefing).toContain("first-tree:generated");
    expect(briefing).toContain("NEVER copy this file");
    expect(briefing).toContain("first-tree agent config prompt show <agent> --raw");
    expect(briefing).toContain("first-tree agent config prompt set <agent> -f <file>");
    expect(briefing).toContain("Every other section is First Tree Managed");
  });

  it("keeps First Tree Managed sections within a compact briefing budget", () => {
    const sourceRepos: PredeclaredSourceRepo[] = [
      { absolutePath: `${AGENT_HOME}/source-repos/first-tree`, url: "https://github.com/example/first-tree" },
    ];
    const promptLines = Array.from({ length: 90 }, (_, index) => `Prompt line ${index + 1}`).join("\n");
    const payload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: promptLines },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "" as const,
    };
    const briefing = buildAgentBriefing(
      makeOpts({
        payload,
        sourceRepos,
        contextTreePath: "/var/lib/context-trees/example",
        contextTreeRepoUrl: "https://github.com/example/context",
        contextTreeBranch: "main",
      }),
    );

    expect(lineCount(topLevelSection(briefing, "# Working in First Tree (First Tree Managed)"))).toBeLessThanOrEqual(
      190,
    );
    expect(briefing).not.toContain("# Required Reading (First Tree Managed)");
    expect(lineCount(topLevelSection(briefing, "# Context Tree (First Tree Managed)"))).toBeLessThanOrEqual(210);
    expect(lineCount(topLevelSection(briefing, "# Skills (First Tree Managed)"))).toBeLessThanOrEqual(20);
    expect(lineCount(briefing)).toBeLessThanOrEqual(550);
  });

  it("renders identity from visibility", () => {
    const privateBriefing = buildAgentBriefing(
      makeOpts({ identity: makeIdentity({ visibility: "private", displayName: "Aly" }) }),
    );
    expect(privateBriefing).toContain("# Identity\n\nYou are Aly, a personal assistant agent.");

    const orgBriefing = buildAgentBriefing(
      makeOpts({ identity: makeIdentity({ visibility: "organization", displayName: "Aly" }) }),
    );
    expect(orgBriefing).toContain("# Identity\n\nYou are Aly, an autonomous agent.");
  });
});

describe("buildAgentBriefing — prompt provenance sections", () => {
  const basePayload = {
    kind: "claude-code" as const,
    model: "",
    prompt: { append: "" },
    mcpServers: [],
    env: [],
    gitRepos: [],
    resourceSkills: [],
    reasoningEffort: "" as const,
  };

  it("renders legacy append only as the legacy fallback", () => {
    expect(buildAgentBriefing(makeOpts({ payload: null }))).not.toContain("## Agent-Specific Prompt");

    const payload = { ...basePayload, prompt: { append: "Follow the local plan." } };
    const briefing = buildAgentBriefing(makeOpts({ payload }));
    expect(briefing).toContain("## Agent-Specific Prompt\n\nFollow the local plan.");
    expect(briefing).not.toContain("# Agent Prompt (this agent only — editable)");
  });

  it("separates team prompt, editable agent prompt, and non-editable overrides", () => {
    const payload = {
      ...basePayload,
      prompt: {
        append: "legacy blob must be ignored",
        sections: [
          { scope: "team" as const, name: "Review Rules", body: "Always review twice.", editable: false },
          { scope: "agent" as const, name: "", body: "Prefer terse replies.", editable: true },
          { scope: "agent" as const, name: "Tone guide", body: "Override body.", editable: false },
        ],
      },
    };

    const briefing = buildAgentBriefing(makeOpts({ payload }));
    expect(briefing).toContain("# Team Prompt (team-shared — read-only for agents)");
    expect(briefing).toContain("## Review Rules\n\nAlways review twice.");
    expect(briefing).toMatch(/do NOT copy any of this into\nyour per-agent prompt/);
    expect(briefing).toContain("# Agent Prompt (this agent only — editable)");
    expect(briefing).toContain("Prefer terse replies.");
    expect(briefing).toContain("first-tree agent config prompt show test-agent --raw");
    expect(briefing).toContain("first-tree agent config prompt set test-agent");
    expect(briefing).toContain("# Agent Prompt Overrides (this agent only — managed via resource bindings)");
    expect(briefing).toContain("## Tone guide\n\nOverride body.");
    expect(briefing).toMatch(/NOT editable with `prompt set`/);
    expect(briefing).not.toContain("## Agent-Specific Prompt");
  });
});

describe("buildAgentBriefing — Context Tree policy and skill routing", () => {
  it("emits the structured Context Tree policy baseline in generated briefing", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");

    expect(tree).toContain("## Context Tree Policy");
    expect(tree).toContain("### Source-System Boundary");
    expect(tree).toContain("### Content Classes And Authority");
    expect(tree).toContain("**Normal content**");
    expect(tree).toContain("**Archive/supporting content**");
    expect(tree).toContain("**Member content**");
    expect(tree).toContain("### Code vs Tree Drift Authority");
    expect(tree).toContain("code is the ground truth");
    expect(tree).toContain("`decisionLocksCode: true` reverses that default");
    expect(tree).toContain("### The Double Test");
    expect(tree).toContain("### Content Model: What / Why / Who");
    expect(tree).toContain("### Add vs Edit");
    expect(tree).toContain("### Node Shape");
    expect(tree).toContain("`lastReviewed` records an actual\nowner review");
    expect(tree).toContain("update it only through that review/audit workflow");
    expect(tree).toContain("never during\na source-backed write");
    expect(tree).toContain('Use `owners: ["*"]` only when a human explicitly opens');
    expect(tree).toContain("ownership to everyone");
    expect(tree).toContain("Metadata supports scanning, routing, and responsibility");
    expect(tree).toContain("### Write / Verify / PR Discipline");
    expect(briefing).not.toMatch(/you MUST\s+load \*\*`first-tree-write`\*\*/);
    expect(briefing).toContain("`first-tree-read`");
    expect(briefing).toContain("`first-tree-seed`");
    expect(briefing).not.toContain(`${AGENT_HOME}/.agents/skills/first-tree/SKILL.md`);
    expect(briefing).not.toContain(`${AGENT_HOME}/.agents/skills/first-tree-context/SKILL.md`);
  });

  it("emits the policy baseline and tree-less binding guidance", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    expect(briefing).not.toContain("# Required Reading");
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");
    expect(tree).toContain("## Context Tree Policy");
    expect(tree).toContain("This briefing was generated without a bound tree");
    expect(tree).toContain("before any tree read/write, re-check the workspace binding");
  });

  it("lists every installed First Tree skill in the family map", () => {
    const familyMap = topLevelSection(
      buildAgentBriefing(makeOpts({ contextTreePath: "/tree" })),
      "# Skills (First Tree Managed)",
    );
    expect(familyMap).toContain("The generated Context Tree Policy above is the always-present baseline");
    expect(familyMap).toMatch(/\|\s*`first-tree-read`\s*\| read relevant Context Tree files before acting/);
    expect(familyMap).toMatch(/\|\s*`first-tree-write`\s*\| reflect a concrete source artifact/);
    expect(familyMap).toMatch(/\|\s*`context-tree-review`\s*\| a Cloud Context Reviewer wake-up/);

    const treelessFamily = topLevelSection(
      buildAgentBriefing(makeOpts({ contextTreePath: null })),
      "# Skills (First Tree Managed)",
    );
    expect(treelessFamily).toContain("first-tree-welcome");
    expect(treelessFamily).toContain("first-tree-seed");
    expect(treelessFamily).toContain("first-tree-file-bug");
    expect(treelessFamily).toMatch(/\|\s*`first-tree-read`\s*\| read relevant Context Tree files before acting/);
    expect(treelessFamily).toMatch(/\|\s*`first-tree-write`\s*\| reflect a concrete source artifact/);
    expect(treelessFamily).toMatch(/\|\s*`context-tree-review`\s*\| a Cloud Context Reviewer wake-up/);
    expect(treelessFamily).toContain("These First Tree skills are installed in every workspace");
    expect(treelessFamily).not.toContain("# Required Reading");
  });
});

describe("buildAgentBriefing — Working in First Tree hard rules", () => {
  it("anchors console/outbox and chat send/ask/update behavior", () => {
    const briefing = buildAgentBriefing(makeOpts());

    expect(briefing).toMatch(/the "user" your underlying agent addresses is the First\s+Tree runtime/);
    expect(briefing).toMatch(/visible live reasoning\/activity trace/);
    expect(briefing).toContain("This is your **console**");
    expect(briefing).toContain("Teammates are reached through the **outbox**");
    expect(briefing).toContain("first-tree chat send");
    expect(briefing).toContain("first-tree chat ask");
    expect(briefing).toContain("first-tree chat update --description");
    expect(briefing).toMatch(/Human message: finish with one/);
    expect(briefing).toMatch(/Agent handoff: `first-tree chat send <agent>`/);
    expect(briefing).toMatch(/Do not send\s+courtesy acknowledgements to agents/);
    expect(briefing).toContain("-F <file>");
    expect(briefing).toContain("-F -");
    expect(briefing).toContain("--description -");
    expect(briefing).toContain("never `JSON.stringify`");
  });

  it("interpolates the working directory and worktree paths", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain(`Your fixed working directory is \`${AGENT_HOME}\`.`);
    expect(briefing).toContain("persistent state");
    expect(briefing).toContain("## Worktrees");
    expect(briefing).toContain("No worktrees are pre-created");
    expect(briefing).toContain(`${AGENT_HOME}/worktrees/<name>-read`);
    expect(briefing).toContain(`${AGENT_HOME}/worktrees/<task-name>`);
    expect(briefing).toContain("worktree remove");
    expect(briefing).not.toContain("<agent-home>/worktrees/");
  });

  it("renders source repos with bare-clone fail-closed protocol and compact legacy gates", () => {
    const sourceRepos: PredeclaredSourceRepo[] = [
      {
        absolutePath: `${AGENT_HOME}/source-repos/api`,
        url: "git@github.com:example/api.git",
        ref: "main",
        branch: "session/test-agent",
      },
      {
        absolutePath: `${AGENT_HOME}/source-repos/web`,
        url: "git@github.com:example/web.git",
      },
    ];
    const briefing = buildAgentBriefing(makeOpts({ sourceRepos }));

    expect(briefing).toContain("## Source Repositories (agent-managed, bare)");
    expect(briefing).toContain(`\`${AGENT_HOME}/source-repos/api\``);
    expect(briefing).toContain("url=git@github.com:example/api.git");
    expect(briefing).toContain("ref=main");
    expect(briefing).toContain("branch=session/test-agent");
    expect(briefing).toContain(`\`${AGENT_HOME}/source-repos/web\``);
    expect(briefing).not.toContain(`\`${AGENT_HOME}/api\``);
    expect(briefing).not.toContain(`\`${AGENT_HOME}/worktrees/api\``);

    expect(briefing).toMatch(/\*\*You manage these clones yourself\*\*/);
    expect(briefing).toContain("git clone --bare <url> <path>");
    expect(briefing).toContain("git -C <path> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'");
    expect(briefing).toContain("git -C <path> remote get-url origin");
    expect(briefing).toMatch(/compare it canonically/);
    expect(briefing).toMatch(/https\/http\/ssh\/git\/scp transport/);
    expect(briefing).toMatch(/If it does\s+\*\*not\*\* match, stop/);
    expect(briefing).toContain("git -C <path> fetch origin");
    expect(briefing).toContain("Credential failures are reportable");

    expect(briefing).toContain("Legacy non-bare workspace checkout");
    expect(briefing).toContain(".first-tree/workspace.json");
    expect(briefing).toContain("reserved workspace dirs");
    expect(briefing).toContain("status --porcelain");
    expect(briefing).toContain("merge-base --is-ancestor");
    expect(briefing).toContain("branch --no-merged origin/<default>");
    expect(briefing).toContain("stash list");
    expect(briefing).toContain('mv -- "$legacy" "$legacy.retired.$(date +%Y%m%d%H%M%S)"');
    expect(briefing).not.toContain("assert_legacy_target() {");
    expect(briefing).not.toContain("rm -rf <legacy>");
  });

  it("omits the Source Repositories block when no repos are declared", () => {
    const briefing = buildAgentBriefing(makeOpts({ sourceRepos: [] }));
    expect(briefing).not.toContain("## Source Repositories");
    expect(briefing).toContain("## Worktrees");
  });

  it("keeps the Communication matrix markers and rich-body safety rules", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const communication = briefing.slice(briefing.indexOf("## Communication"));

    expect(communication).toMatch(/business action changes the workspace\s+or outside world/);
    expect(communication).toContain("Replying to a human is required, not optional");
    expect(communication).toContain("never to a\nfresh human-directed message");
    expect(communication).toContain("Blocking questions never ride inside plain `chat send`");
    expect(communication).toContain("route by dependency, not importance");
    expect(communication).toContain("chat update --description -");
    expect(communication).toContain("Do not send courtesy acknowledgements");
    expect(communication).toMatch(/group chats reject no-recipient/i);
    expect(communication).toContain("chat create --to <name>");
    expect(communication).toContain("@EOF");
    expect(communication).toContain("Issue #389");
    expect(communication).toMatch(/Use\s+`-f markdown`/);
  });

  it("uses the channel-resolved binary name in chat commands", () => {
    setCliBinding({ binName: "first-tree-staging", packageName: "first-tree-staging" });
    try {
      const briefing = buildAgentBriefing(makeOpts());
      expect(briefing).toContain("first-tree-staging chat send");
      expect(briefing).not.toMatch(/\bfirst-tree chat /);
    } finally {
      setCliBinding({ binName: "first-tree", packageName: "first-tree" });
    }
  });
});

describe("buildAgentBriefing — asking humans, GitHub, and CLI overview", () => {
  it("keeps chat ask dependency routing and self-sufficient body requirements", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const asking = briefing.slice(briefing.indexOf("## Asking Humans"));

    expect(asking).toContain("raises a tracked open question");
    expect(asking).toContain("The routing test is **dependency, not importance**");
    expect(asking).toContain("genuinely the user's to make");
    expect(asking).toContain("Do NOT manufacture");
    expect(asking).toContain("can I continue?");
    expect(asking).toContain("can cite them");
    expect(asking).toContain("Ask volume should fall");
    expect(asking).toContain("body IS the ask");
    expect(asking).toContain("decision-self-sufficient");
    expect(asking).toContain("Why this question exists");
    expect(asking).toContain("Recent context");
    expect(asking).toContain("**The question**");
    expect(asking).toContain("required content dimensions, not mandatory headings");
    expect(asking).toContain("more specific agent/task/workflow template");
    expect(asking).toContain("preserve that template");
    expect(asking).not.toContain("include exactly these sections");
    expect(asking).toContain("--options");
    expect(asking).toContain("--multi-select");
    expect(asking).toContain("human resolves");
    expect(asking).not.toContain("--answer");
    expect(asking).not.toContain("--question");
    expect(asking).not.toContain("--close");
  });

  it("keeps GitHub posture and follow-after-create rules inline", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## GitHub Working Posture");
    expect(briefing.indexOf("## GitHub Working Posture")).toBeLessThan(briefing.indexOf("## GitHub Entity Attention"));
    expect(briefing).toContain("try the host `gh` CLI first");
    expect(briefing).toContain("not by itself a reason to ask for First Tree GitHub App");
    expect(briefing).toContain("If the current member is not an org admin");
    expect(briefing).toContain("hidden server sync path");

    expect(briefing).toContain("Creating a PR or issue **never** follows it");
    expect(briefing).toContain("first-tree github follow <url>");
    expect(briefing).toMatch(/clearly unrelated to this chat's task/);
    expect(briefing).toContain("first-tree github unfollow <entity>");
    expect(briefing).toMatch(/human explicitly asks to stop tracking/);
    expect(briefing).toContain("first-tree github follow --help");
    expect(briefing).not.toContain("`first-tree-github` skill");
  });

  it("keeps chat metadata rules compact but actionable", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const chatTopic = briefing.slice(briefing.indexOf("## Chat Topic & Description"));

    expect(chatTopic).toContain('provider-injected "Current Chat Context"');
    expect(chatTopic).toContain("short (<= 30 chars)");
    expect(chatTopic).toContain("调研 chat rename 方案");
    expect(chatTopic).toContain("本周 ship 计划");
    expect(chatTopic).toContain("chat update --topic");
    expect(chatTopic).toContain("chat update --description");
    expect(chatTopic).toContain("deprecated alias");
    expect(chatTopic).toContain("a 403 means\nstop, not retry");
    expect(chatTopic).toContain("leave it stable");
    expect(chatTopic).toContain("within 1500 characters");
    expect(chatTopic).toContain("Rewrite it in place");
    expect(chatTopic).toContain("history\nis the log");
    expect(chatTopic).toContain("Markdown is supported");
    expect(chatTopic).toMatch(/use\s+`first-tree chat ask <human>`/);
    expect(chatTopic).toContain("chat list");
    expect(chatTopic).toContain("chat history <chat>");
    expect(chatTopic).toContain("GitHub-sourced topics");
    expect(chatTopic).not.toContain("bottom of this briefing");
  });

  it("lists only registered CLI namespaces and tree subcommands", () => {
    const briefing = buildAgentBriefing(makeOpts());
    const overview = briefing.slice(briefing.indexOf("## CLI Overview"));

    expect(overview).toContain("first-tree chat …");
    expect(overview).toContain("first-tree agent …");
    expect(overview).toContain("first-tree daemon …");
    expect(overview).toContain("first-tree github …");
    expect(overview).toContain("first-tree tree verify");
    expect(overview).toContain("first-tree tree tree");
    expect(overview).not.toContain("github scan");
    expect(overview).not.toContain("first-tree tree …");

    for (const retired of [
      "status",
      "init",
      "migrate",
      "upgrade",
      "codeowners",
      "claude-hook",
      "inject",
      "review",
      "automation",
      "skill",
      "read",
      "write",
      "publish",
    ]) {
      const re = new RegExp(`\\b(?:first-tree|ft)\\s+tree\\s+${retired}\\b`, "u");
      expect(overview, `CLI Overview must not advertise retired tree ${retired}`).not.toMatch(re);
    }
  });
});

describe("buildAgentBriefing — Context Tree", () => {
  it("keeps read/write triggers, root files, verify, and PR ordering", () => {
    const treePath = "/var/lib/context-trees/example";
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: treePath }));
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");

    expect(tree).toContain("## Core Model");
    expect(tree).toContain("decisions,\nconstraints, ownership, and cross-domain relationships");
    expect(tree).toContain("## Context Tree Policy");
    expect(tree).toContain("load `first-tree-write`");
    expect(tree).toContain("load `first-tree-read`");
    expect(tree).toContain("exclusively, not `first-tree-read`");
    expect(tree).toContain("**Normal content**");
    expect(tree).toContain("**Archive/supporting content**");
    expect(tree).toContain("**Member content**");
    expect(tree).toContain("Default to normal content as current truth");

    expect(tree).toContain("repo/path/feature/domain/owner/source signal");
    expect(tree).toContain("code, CLI, review, repo, path,\nbug, and error tasks");
    expect(tree).toContain("first-tree tree tree --help");
    expect(tree).toContain("tree tree` selectors");
    expect(tree).toContain("root `NODE.md`");
    expect(tree).toMatch(/If the root also contains an\s+`AGENTS\.md`, read it too/);
    expect(tree).toContain("the tree wins");

    expect(tree).toContain("fresh context");
    expect(tree).toContain("persistent context");
    expect(tree).toContain("specific PR, design doc");
    expect(tree).toMatch(/request explicitly includes\s+creating and updating the needed tree-node\s+files/);
    expect(tree).toContain("`NODE.md` and other `*.md` nodes");
    expect(tree).toMatch(/Implementation-only changes skip\s+the tree write/);
    expect(tree).toContain("If there is no specific source artifact");
    expect(tree).toContain("first-tree tree verify");
    expect(tree).toContain("open them together");
    expect(tree).toContain("cross-link");
    expect(tree).toContain("open the tree PR as a draft");
    expect(tree).toContain("merge the code PR first");
    expect(tree).toContain("final merged code");
    expect(tree).not.toContain("need not merge first");
    expect(tree).not.toContain("`first-tree-context`");
    expect(tree).not.toContain("`first-tree-sync`");

    expect(tree).toContain(treePath);
  });

  it("surfaces tree-less binding as a human/operator gap", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    const cli = briefing.slice(
      briefing.indexOf("## CLI Overview"),
      briefing.indexOf("# Context Tree (First Tree Managed)"),
    );
    const tree = topLevelSection(briefing, "# Context Tree (First Tree Managed)");
    expect(cli).toContain("run its `tree init` path directly");
    expect(cli).toContain("do not pre-confirm admin or ask who will bind");
    expect(cli).toContain("only if the command actually fails");
    expect(cli).not.toContain("confirmed org admin");
    expect(tree).toContain("At briefing generation time this agent had no Context Tree bound");
    expect(tree).toContain("Re-check the\nbinding if the user says a tree was created or bound during the session");
    expect(tree).toMatch(/surface that\s+gap to a human/);
    expect(tree).toContain("operator action");
    expect(tree).toContain("build / set up the Context Tree");
    expect(tree).toContain("without pre-confirming admin");
    expect(tree).toContain('asking "who runs the\nbind?"');
    expect(tree).toContain("validates admin/auth and fails closed");
    expect(tree).toContain("only after an actual command failure");
    expect(tree).not.toContain("confirmed org admin");
    expect(tree).not.toContain("first-tree-onboarding");
  });

  it("shell-quotes interpolated tree clone command values", () => {
    const briefing = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/var/lib/context trees/example",
        contextTreeRepoUrl: "https://example.com/release/$VERSION.git",
        contextTreeBranch: "feature with space",
      }),
    );
    const treeLocation = briefing.slice(briefing.indexOf("## Tree Location"));

    expect(treeLocation).toContain(
      "git clone --branch 'feature with space' --single-branch 'https://example.com/release/$VERSION.git' '/var/lib/context trees/example'",
    );
    expect(treeLocation).toContain("rm '/var/lib/context trees/example'");
    expect(treeLocation).toContain("git -C '/var/lib/context trees/example' pull --ff-only");
    expect(treeLocation).toContain("git -C '/var/lib/context trees/example' worktree add");

    const singleQuote = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/tmp/it's-fine",
        contextTreeRepoUrl: "https://example.com/x.git",
        contextTreeBranch: "main",
      }),
    );
    expect(singleQuote.slice(singleQuote.indexOf("## Tree Location"))).toContain("'/tmp/it'\\''s-fine'");
  });
});

describe("buildAgentBriefing — Skills", () => {
  it("lists only shipped First Tree family skills", () => {
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

    const skillMap = topLevelSection(
      buildAgentBriefing(makeOpts({ contextTreePath: "/tree" })),
      "# Skills (First Tree Managed)",
    );
    for (const name of shippedSkills) {
      expect(skillMap).toContain(`\`${name}\``);
    }
    expect(skillMap).not.toContain("`first-tree-github-scan`");
    expect(skillMap).not.toContain("`attention`");
    expect(skillMap).not.toContain("`github-scan`");
  });

  it("nests Team Skills before First Tree Family when resource skills exist", () => {
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
    const skills = topLevelSection(briefing, "# Skills (First Tree Managed)");

    expect(skills).toContain("## Team Skills");
    expect(skills).toContain("internal-playbook: Team-internal playbook");
    expect(skills).toContain("## First Tree Family");
    expect(skills.indexOf("## Team Skills")).toBeLessThan(skills.indexOf("## First Tree Family"));
  });
});
