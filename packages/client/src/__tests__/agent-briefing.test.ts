import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    workspacePath: AGENT_HOME,
    sourceRepos: [],
    contextTreePath: null,
    ...overrides,
  };
}

describe("buildAgentBriefing — top-level structure & section order", () => {
  it("resolves the checked-in source EJS template and renders through it", () => {
    const templatePath = resolveAgentBriefingTemplatePath();

    expect(templatePath).toBe(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "runtime", "templates", "agent-briefing.ejs"),
    );

    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("# Identity\n\nYou are Test Agent, an autonomous agent.");
    expect(briefing.endsWith("\n")).toBe(true);
  });

  it("emits stable shared sections without per-chat Current Chat Context", () => {
    // Tree-bound case so every shared header in the expected order list is
    // present; tree-less cases are exercised in their dedicated describe
    // blocks below. Per-chat context is provider/session injected and must not
    // appear in this shared file.
    const briefing = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/var/lib/context-trees/example",
      }),
    );

    // Per-agent header ordering invariant: every # / ## that is part of the
    // briefing skeleton must appear in this order. Runtime-injected
    // per-chat context is deliberately absent so the prompt cache stays warm
    // and sibling chats cannot overwrite each other through AGENTS.md.
    // Runtime-injected sections carry the `(First Tree Managed)` provenance
    // suffix so an agent reading the assembled file can tell which sections
    // its prompt config does NOT own (the anti-"copy AGENTS.md back into
    // config" defense, together with the generated-file banner).
    const expectedOrder = [
      "# Identity",
      "# Working in First Tree (First Tree Managed)",
      "## Working Directory",
      "## Worktrees (how you read AND write a bare source repo)",
      "## Communication",
      "## Workspace Collaboration",
      "## GitHub Entity Attention",
      "## Asking Humans",
      "## Chat Topic & Description",
      "## CLI Overview",
      "# Required Reading (First Tree Managed)",
      "# Context Tree (First Tree Managed)",
      "## Core Model",
      "## Reading the Tree",
      "## Writing the Tree",
      "## Tree Location (agent-managed clone)",
      "# Skills (First Tree Managed)",
      "## First Tree Family",
    ];
    let last = -1;
    for (const header of expectedOrder) {
      // The generated-file banner precedes every section, so each header —
      // including the first — sits after a newline.
      const idx = briefing.indexOf(`\n${header}\n`, Math.max(last, 0));
      expect(idx, `header "${header}" missing or out of order`).toBeGreaterThan(last);
      last = idx;
    }
    expect(briefing).not.toContain("## Current Chat Context");
    expect(briefing).not.toContain("Chat ID:");
  });

  it("opens with the generated-file banner: marker + edit map for Team / Agent Prompt", () => {
    const briefing = buildAgentBriefing(makeOpts());
    // Banner must be the very first content so any reader (or any tool that
    // copies the file) hits the marker before anything else.
    expect(briefing.startsWith("<!--")).toBe(true);
    // The literal marker is what the server / CLI write-side guard keys on
    // (AGENT_BRIEFING_GENERATED_MARKER) — pin it as a string so a rename
    // breaks this test and forces the guard to be updated in lockstep.
    expect(briefing).toContain("first-tree:generated");
    expect(briefing).toContain("NEVER copy this file");
    // Edit map: where each editable section actually lives, with the
    // channel-resolved binary name interpolated.
    expect(briefing).toContain("first-tree agent config prompt show <agent> --raw");
    expect(briefing).toContain("first-tree agent config prompt set <agent> -f <file>");
    expect(briefing).toContain("Every other section is First Tree Managed");
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

  it("emits the legacy `## Agent-Specific Prompt` fallback only when prompt.sections is absent and append is non-empty", () => {
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

    // Legacy server (no structured sections) with real content → fallback
    // block emitted with the trimmed payload text. The legacy blob may mix
    // team and agent content, so it must NOT be presented under the editable
    // `# Agent Prompt` heading.
    const realPayload = { ...emptyPayload, prompt: { append: "Follow the local implementation plan." } };
    const briefing = buildAgentBriefing(makeOpts({ payload: realPayload }));
    expect(briefing).toContain("## Agent-Specific Prompt\n\nFollow the local implementation plan.");
    expect(briefing).not.toContain("# Agent Prompt (this agent only — editable)");
  });
});

describe("buildAgentBriefing — # Team Prompt / # Agent Prompt (structured prompt sections)", () => {
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

  it("renders team sections read-only and the agent fragment editable, under separate provenance headings", () => {
    const payload = {
      ...basePayload,
      prompt: {
        // Legacy merged blob is still populated by the server for old
        // clients — when structured sections exist it must be IGNORED, or
        // team content would render twice.
        append: "## Team Resource: Review Rules\n\nAlways review twice.",
        sections: [
          { scope: "team" as const, name: "Review Rules", body: "Always review twice.", editable: false },
          { scope: "agent" as const, name: "", body: "Prefer terse replies.", editable: true },
        ],
      },
    };
    const briefing = buildAgentBriefing(makeOpts({ payload }));

    // Team block: provenance heading + read-only warning + the resource body
    // under its own `##` name.
    expect(briefing).toContain("# Team Prompt (team-shared — read-only for agents)");
    expect(briefing).toContain("## Review Rules\n\nAlways review twice.");
    expect(briefing).toMatch(/do NOT copy any of this into\nyour per-agent prompt/);

    // Agent block: provenance heading + copy-pasteable round-trip commands
    // using the CLI-addressable agent name (agentId, not display name).
    expect(briefing).toContain("# Agent Prompt (this agent only — editable)");
    expect(briefing).toContain("Prefer terse replies.");
    expect(briefing).toContain("first-tree agent config prompt show test-agent --raw");
    expect(briefing).toContain("first-tree agent config prompt set test-agent");

    // Structured sections supersede the legacy single-blob rendering.
    expect(briefing).not.toContain("## Agent-Specific Prompt");

    // Order: Identity → Team Prompt → Agent Prompt → Working in First Tree.
    // Anchor on the full heading lines (the banner's edit map also mentions
    // `# Team Prompt` / `# Agent Prompt` as indented references).
    const identityIdx = briefing.indexOf("\n# Identity\n");
    const teamIdx = briefing.indexOf("\n# Team Prompt (team-shared — read-only for agents)\n");
    const agentIdx = briefing.indexOf("\n# Agent Prompt (this agent only — editable)\n");
    const workingIdx = briefing.indexOf("\n# Working in First Tree (First Tree Managed)\n");
    expect(teamIdx).toBeGreaterThan(identityIdx);
    expect(agentIdx).toBeGreaterThan(teamIdx);
    expect(workingIdx).toBeGreaterThan(agentIdx);
  });

  it("omits each provenance heading when no section of that scope has content", () => {
    // Anchor on the full heading lines — the banner's edit map mentions
    // `# Team Prompt` / `# Agent Prompt` as indented references, so bare
    // substring checks would false-positive on every briefing.
    const teamHeading = "\n# Team Prompt (team-shared — read-only for agents)\n";
    const agentHeading = "\n# Agent Prompt (this agent only — editable)\n";

    const teamOnly = {
      ...basePayload,
      prompt: { append: "", sections: [{ scope: "team" as const, name: "Rules", body: "Body." }] },
    };
    const teamOnlyBriefing = buildAgentBriefing(makeOpts({ payload: teamOnly }));
    expect(teamOnlyBriefing).toContain(teamHeading);
    expect(teamOnlyBriefing).not.toContain(agentHeading);

    const agentOnly = {
      ...basePayload,
      prompt: { append: "", sections: [{ scope: "agent" as const, name: "", body: "Mine.", editable: true }] },
    };
    const agentOnlyBriefing = buildAgentBriefing(makeOpts({ payload: agentOnly }));
    expect(agentOnlyBriefing).not.toContain(teamHeading);
    expect(agentOnlyBriefing).toContain(agentHeading);

    // Whitespace-only bodies count as empty.
    const blank = {
      ...basePayload,
      prompt: { append: "", sections: [{ scope: "team" as const, name: "Rules", body: "  \n " }] },
    };
    const blankBriefing = buildAgentBriefing(makeOpts({ payload: blank }));
    expect(blankBriefing).not.toContain(teamHeading);
    expect(blankBriefing).not.toContain(agentHeading);
  });

  it("falls back to a default `## Team prompt` sub-heading when a team section has no name", () => {
    const payload = {
      ...basePayload,
      prompt: { append: "", sections: [{ scope: "team" as const, name: "  ", body: "Unnamed body." }] },
    };
    const briefing = buildAgentBriefing(makeOpts({ payload }));
    expect(briefing).toContain("## Team prompt\n\nUnnamed body.");
  });

  it("renders non-editable agent-scope sections under # Agent Prompt Overrides, never under the editable heading", () => {
    // An inline *replacement* of a team prompt projects as scope "agent"
    // without `editable` — the `prompt show --raw` / `prompt set` round-trip
    // cannot touch it, so presenting it under "editable" would instruct the
    // agent to use a flow that cannot edit the content it sees.
    const payload = {
      ...basePayload,
      prompt: {
        append: "",
        sections: [
          { scope: "agent" as const, name: "", body: "My own fragment.", editable: true },
          { scope: "agent" as const, name: "Tone guide", body: "Agent-specific tone override.", editable: false },
        ],
      },
    };
    const briefing = buildAgentBriefing(makeOpts({ payload }));

    const agentHeading = "\n# Agent Prompt (this agent only — editable)\n";
    const overridesHeading = "\n# Agent Prompt Overrides (this agent only — managed via resource bindings)\n";
    expect(briefing).toContain(agentHeading);
    expect(briefing).toContain(overridesHeading);
    expect(briefing).toContain("## Tone guide\n\nAgent-specific tone override.");
    expect(briefing).toMatch(/NOT editable with `prompt set`/);

    // The override body must live in the overrides section, after the
    // editable section — not inside it.
    const agentIdx = briefing.indexOf(agentHeading);
    const overridesIdx = briefing.indexOf(overridesHeading);
    const overrideBodyIdx = briefing.indexOf("Agent-specific tone override.");
    expect(overridesIdx).toBeGreaterThan(agentIdx);
    expect(overrideBodyIdx).toBeGreaterThan(overridesIdx);

    // Overrides alone (no editable fragment) must not produce the editable
    // heading — and must not fall back to the legacy single-blob rendering.
    const overridesOnly = {
      ...basePayload,
      prompt: {
        append: "legacy blob",
        sections: [{ scope: "agent" as const, name: "Tone guide", body: "Override only.", editable: false }],
      },
    };
    const overridesOnlyBriefing = buildAgentBriefing(makeOpts({ payload: overridesOnly }));
    expect(overridesOnlyBriefing).not.toContain(agentHeading);
    expect(overridesOnlyBriefing).toContain(overridesHeading);
    expect(overridesOnlyBriefing).not.toContain("## Agent-Specific Prompt");
  });
});

describe("buildAgentBriefing — # Required Reading (unconditional skill-load mandate)", () => {
  // The inline briefing is a routing index, not a substitute for the
  // skill payloads. `# Required Reading` is the hard mandate that
  // guarantees `first-tree-write` gets loaded on
  // every task — otherwise progressive disclosure (keyword-triggered)
  // can silently skip them and the agent acts without the rules in
  // that skill (tree concept model, hard write rules, etc.).

  it("emits the # Required Reading section for tree-bound agents with MUST framing and the write skill", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));

    expect(briefing).toContain("# Required Reading");
    expect(briefing).toMatch(/you MUST\s+load \*\*`first-tree-write`\*\*/);
    expect(briefing).toContain("source-system boundary");
    expect(briefing).toContain("Hard Rules + Double Test");
    // Claude Code's transcript exposes a skill listing, but native skill-body
    // injection is still provider-owned. The briefing must give a direct
    // filesystem fallback so "unconditional" is actionable even when the
    // provider only listed the skill names.
    expect(briefing).toContain(`${AGENT_HOME}/.agents/skills/first-tree-write/SKILL.md`);
    expect(briefing).toMatch(/minimum\s+mechanics you need to operate at all/);
    expect(briefing).toMatch(/inline briefing only summarises/);
    // Calls out the on-demand-only sibling so the agent doesn't
    // over-load every First Tree family skill on every task.
    expect(briefing).toContain("`first-tree-read`");
    expect(briefing).toContain("`first-tree-seed`");
    expect(briefing).not.toContain(`${AGENT_HOME}/.agents/skills/first-tree/SKILL.md`);
    expect(briefing).not.toContain(`${AGENT_HOME}/.agents/skills/first-tree-context/SKILL.md`);
  });

  it("places # Required Reading immediately after # Working in First Tree (its CLI Overview tail) and before # Context Tree", () => {
    // Placement rationale: the agent first reads the inline
    // workspace-collab basics (chat send, working directory,
    // communication) it needs to operate at all, then hits the hard
    // mandate to load `first-tree-write` before any real work. The
    // mandate sits adjacent to `# Context Tree` because that skill covers
    // the tree concept/write rules for that section.
    const payload = {
      kind: "claude-code" as const,
      model: "",
      prompt: { append: "You are staff: design, implement, and coordinate review." },
      mcpServers: [],
      env: [],
      gitRepos: [],
      resourceSkills: [],
      reasoningEffort: "" as const,
    };
    const briefing = buildAgentBriefing(makeOpts({ payload, contextTreePath: "/tree" }));

    const identityIdx = briefing.indexOf("# Identity");
    const agentPromptIdx = briefing.indexOf("## Agent-Specific Prompt");
    const workingIdx = briefing.indexOf("# Working in First Tree");
    const cliOverviewIdx = briefing.indexOf("## CLI Overview");
    const requiredIdx = briefing.indexOf("# Required Reading");
    const contextTreeIdx = briefing.indexOf("# Context Tree");

    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(agentPromptIdx).toBeGreaterThan(identityIdx);
    expect(workingIdx).toBeGreaterThan(agentPromptIdx);
    // CLI Overview is the last subsection of `# Working in First Tree`,
    // so Required Reading must land after it.
    expect(cliOverviewIdx).toBeGreaterThan(workingIdx);
    expect(requiredIdx).toBeGreaterThan(cliOverviewIdx);
    // And immediately before `# Context Tree` — no other top-level
    // section may slip between them.
    expect(contextTreeIdx).toBeGreaterThan(requiredIdx);
  });

  it("omits # Required Reading for tree-less agents (the unconditional write mandate is a tree-ops discipline)", () => {
    // `# Required Reading` mandates loading `first-tree-write` UNCONDITIONALLY
    // on every task — a tree-ops discipline for reflecting sources into an
    // existing tree. A tree-less agent DOES carry write on disk now (it ships
    // core as first-tree-seed's dependency), but should load it only when seed
    // pulls it in, not on every task, so the mandate stays tree-bound. The
    // tree-less core skills are surfaced by the First Tree Family map instead.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    expect(briefing).not.toContain("# Required Reading");
  });

  it("flags `first-tree-write` as unconditional in the ## First Tree Family map (consistent with # Required Reading)", () => {
    // The Skill Map's framing has to match the # Required Reading
    // mandate, otherwise the agent gets contradictory signals
    // (progressive-disclosure-only vs. unconditional). Pin both
    // rows' new "unconditional" label and the head paragraph that
    // calls them out.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const familyMap = briefing.slice(briefing.indexOf("## First Tree Family"));

    // Head paragraph explicitly names the unconditional skill and
    // points back at the # Required Reading anchor.
    expect(familyMap).toMatch(
      /`first-tree-write` is \*\*unconditional\*\* — load it on every task per\s+`# Required Reading` above\./,
    );

    // The unconditional row must carry the "unconditional" label
    // inline so the table is self-explanatory even when read in
    // isolation.
    const writeRow = familyMap.match(/\|\s*`first-tree-write`\s*\|[^\n]*/)?.[0] ?? "";
    expect(writeRow).toContain("unconditional");
    expect(writeRow).toContain("`# Required Reading`");
    expect(writeRow).toContain("concept model");
    expect(writeRow).toContain("source-driven tree writes");
    expect(writeRow).not.toContain("read context before acting");

    // On-demand rows must NOT pick up the unconditional label by
    // accident — they're triggered by keyword / task signal.
    const readRow = familyMap.match(/\|\s*`first-tree-read`\s*\|[^\n]*/)?.[0] ?? "";
    expect(readRow).not.toContain("unconditional");
    expect(readRow).toContain("before acting");

    const seedRow = familyMap.match(/\|\s*`first-tree-seed`\s*\|[^\n]*/)?.[0] ?? "";
    expect(seedRow).not.toContain("unconditional");
  });
});

describe("buildAgentBriefing — # Working in First Tree subsections", () => {
  it("emits the runtime intro block: chat send reaches any teammate, ask/update for humans, courtesy-send guard, Issue #389", () => {
    const briefing = buildAgentBriefing(makeOpts());

    // `chat send` reaches any teammate — agent or human (a plain send to a human
    // is a free reply); a human also has `chat ask` (decisions) and
    // `chat update --description` (progress).
    expect(briefing).toContain("`first-tree chat send <name>` reaches any teammate — agent or human");
    expect(briefing).toContain("first-tree chat ask <human>");
    expect(briefing).toContain("first-tree chat update --description");
    expect(briefing).not.toMatch(/server rejects a `?chat send`? to a human/);

    // yuezengwu 2026-06-26: rebind, rather than negate, the agent's native
    // output model with one provider-neutral boundary rule — everything apart
    // from an explicit chat command is the console (addressed to the First Tree
    // runtime); the chat commands are the outbox (the only path to a teammate).
    // Stating it by exclusion binds the turn-closing message (Codex's `final`
    // prior) without naming a provider. Keep the PRECISE product boundary
    // (codex R1/R5): the output is not an addressed reply, yet it is visible —
    // a one-line preview surfaces as live session activity to viewers.
    expect(briefing).toMatch(/the "user" your underlying agent addresses is the First\s+Tree runtime/i);
    expect(briefing).toMatch(/Everything you produce apart from an explicit chat\s+command/i);
    expect(briefing).toMatch(/message that closes your turn/i);
    expect(briefing).toMatch(/live reasoning\/activity trace/i);
    expect(briefing).toMatch(/treating it as visible/i);
    expect(briefing).toMatch(/live session activity/i);
    expect(briefing).toMatch(/This is your \*\*console\*\*/i);
    expect(briefing).toMatch(/the outbox: the explicit\s+commands/i);
    expect(briefing).toMatch(/places your message in front of\s+a teammate/i);
    // The outbox-completion rule is scoped to HUMAN-directed turns, so it never
    // contradicts the adjacent agent no-courtesy-send brake (codex review R5):
    // an agent no-op wake-up must still be allowed to end without a send.
    expect(briefing).toMatch(/A human-directed\s+turn is complete once you deliver your reply through the outbox/i);
    expect(briefing).toMatch(/an agent\s+wake-up with nothing new to act on can end without a send/i);
    expect(briefing).not.toMatch(/teammate triggered is complete/i);
    // The retired mirror term stays out — there is no `agent-final-text` row
    // post-#1190.
    expect(briefing).not.toContain("agent-final-text");
    // Provider-neutral: the brief no longer names a specific harness.
    expect(briefing).not.toMatch(/Claude Code harness/i);

    // Courtesy-send guard stays — the brake is on the *send* side.
    expect(briefing).toContain("Don't fire a courtesy");
    expect(briefing).toContain("end the turn without sending");
    expect(briefing).not.toMatch(/\boutput nothing\b/);

    // Issue #389: pin the anti-double-encode rule (rationale now in the
    // Communication block, where the shell-mechanics WHY was moved).
    expect(briefing).toContain("Issue #389");
    expect(briefing).toContain("JSON.stringify");
    // Pin the `-F`/stdin body rule (the shell-quote regression fix): a concise
    // affirmative principle up top, with the detailed shell-mechanics rationale
    // (heredoc residue `@EOF`, the CLI cannot repair it) moved down into the
    // Communication block.
    expect(briefing).toMatch(/Form a rich body as a file or stdin/i);
    expect(briefing).toMatch(/-F|stdin/);
    expect(briefing).toContain("-f markdown");
    expect(briefing).toMatch(/Why a rich body goes through a file or stdin/i);
    expect(briefing).toContain("@EOF");
  });

  it("interpolates the agent home into the Working Directory block", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## Working Directory");
    expect(briefing).toContain(`Your fixed working directory is \`${AGENT_HOME}\`.`);
    expect(briefing).toContain("absolute");
    expect(briefing).toContain("persistent state");
  });

  it("emits the Worktrees block (read + write worktree convention) regardless of source repos presence", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## Worktrees");
    expect(briefing).toContain("No worktrees are pre-created");
    // Bare-clone worktree commands run against the clone with `git -C <source>`.
    expect(briefing).toContain("worktree add");
    // Bare-clone model: both a read worktree and a task (write) worktree are
    // documented. Only `<name>` / `<task-name>` / `<new-branch>` are literal
    // placeholders; the home prefix is interpolated.
    expect(briefing).toContain(`${AGENT_HOME}/worktrees/<name>-read`);
    expect(briefing).toContain(`${AGENT_HOME}/worktrees/<task-name>`);
    expect(briefing).toContain("worktree remove");
    // No literal `<placeholder>` for the home prefix — LLMs sometimes copy
    // those verbatim.
    expect(briefing).not.toContain("<agent-home>/worktrees/");
  });

  it("renders predeclared source repos with source-repos/ paths and upstream coordinates", () => {
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
    // Source clones live under `source-repos/`, not at the workspace root and
    // not under `worktrees/`.
    expect(briefing).toContain(`\`${AGENT_HOME}/source-repos/api\``);
    expect(briefing).not.toContain(`\`${AGENT_HOME}/worktrees/api\``);
    expect(briefing).not.toContain(`\`${AGENT_HOME}/api\``);
    expect(briefing).toContain("url=git@github.com:example/api.git");
    expect(briefing).toContain("ref=main");
    expect(briefing).toContain("branch=session/test-agent");
    expect(briefing).toContain(`\`${AGENT_HOME}/source-repos/web\``);
    // Partial entry — only url should appear, ref/branch parens omitted.
    expect(briefing).not.toMatch(/url=git@github\.com:example\/web\.git,\s*ref=/);
    // Agent-managed bare protocol: the agent maintains bare clones itself
    // and reads/writes only through worktrees.
    expect(briefing).toContain("**You manage these clones yourself**");
    expect(briefing).toContain("bare");
    expect(briefing).toContain("git clone --bare <url> <path>");
    // refspec config makes refs/remotes/origin/* available for worktrees.
    expect(briefing).toContain("git -C <path> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'");
    // Clones live under the workspace's `source-repos/` directory. `git clone`
    // does create the missing parent on its own (verified), but the protocol
    // makes it explicit with `mkdir -p` so an agent that deviates from the exact
    // clone command can't trip over a missing `source-repos/` parent.
    expect(briefing).toContain("source-repos/");
    expect(briefing).toContain("immediate child of your workspace's");
    expect(briefing).toContain('mkdir -p "$(dirname <path>)"');
    // Read goes through a worktree, not the clone path; skills scan there too.
    expect(briefing).toContain("Read through a worktree, not the clone path.");
    expect(briefing).toContain("first-tree-seed");
    expect(briefing).not.toContain("first-tree-sync");
    expect(briefing).toContain("fetch origin");
    expect(briefing).toContain("origin/main");
    // Fail-closed repoint guard — carries main's #1058 invariant (a source
    // path repointed from repoA to repoB must not silently serve the old
    // clone) into the agent-managed protocol. The agent verifies the existing
    // clone's origin against the declared url and blocks on a mismatch instead
    // of reusing it unconditionally.
    expect(briefing).toContain("fail closed");
    expect(briefing).toContain("git -C <path> remote get-url origin");
    expect(briefing).toMatch(/does NOT match/);
    // Reuse is now CONDITIONAL on the origin matching — not an unconditional
    // "reuse the existing path as-is".
    expect(briefing).toContain("**If it matches**, reuse the clone");
    // One-time legacy-layout migration: an agent provisioned under the old
    // non-bare-checkout-at-workspace-root layout gets a safe, scoped recipe
    // to retire it — drop only clean + already-merged worktrees, then the
    // checkout — and is told to stay inside its OWN workspace.
    expect(briefing).toContain("One-time legacy-layout migration");
    expect(briefing).toContain("never reach into a sibling agent's");
    expect(briefing).toContain("merge-base --is-ancestor <wt-HEAD> origin/<default>");
    // P0 (issue #1086): the retire target must be mechanically constrained, not
    // hand-filled. A path preflight derives `$legacy` from the manifest and
    // proves it is exactly the intended legacy checkout before the git-state
    // gates run — resolve workspace root from `.first-tree/workspace.json`,
    // realpath + immediate-child check, reject reserved workspace dirs and
    // symlinks, require the toplevel/non-bare/origin to all match.
    expect(briefing).toContain('[ -f "$d/.first-tree/workspace.json" ]');
    expect(briefing).toContain("assert_legacy_target() {");
    expect(briefing).toContain("reserved workspace dir");
    expect(briefing).toContain(".first-tree|source-repos|worktrees|context-tree)");
    // Every gate runs against `$candidate`, never `$legacy`.
    expect(briefing).toContain('real=$(realpath "$candidate")');
    expect(briefing).toContain("reject: target is the workspace root");
    expect(briefing).toContain("is not an immediate child of");
    expect(briefing).toContain('git -C "$candidate" rev-parse --show-toplevel');
    expect(briefing).toContain("rev-parse --is-bare-repository");
    expect(briefing).toContain('git -C "$candidate" remote get-url origin');
    // Blocker (yuezengwu / codex-bot on PR #1087): `$legacy` is cleared on entry
    // and only published after EVERY gate passes, so a rejected/failed call can
    // never leave a stale target for the git-state gates that follow.
    expect(briefing).toContain("name=$1 want=$2 legacy= candidate=$WS/$name");
    expect(briefing).toContain("  legacy=$candidate");
    // Blocker (codex-assistant on PR #1087, per #1086): the origin compare is
    // canonical — `.git` and the https/http/ssh/git/scp transport forms all
    // collapse to host/path, so a legitimate checkout cloned via a different URL
    // form is not rejected as wrong-origin (behaviorally exercised below).
    expect(briefing).toContain("canon_url() {");
    expect(briefing).toContain('[ "$(canon_url "$got")" = "$(canon_url "$want")" ]');
    // The candidate path is derived per declared source and baked from the
    // manifest, so the agent never hand-fills a naked `<legacy>` placeholder.
    expect(briefing).toContain("assert_legacy_target 'api' 'git@github.com:example/api.git'");
    expect(briefing).toContain("assert_legacy_target 'web' 'git@github.com:example/web.git'");
    // Git-state gates now run against the validated `$legacy` variable, not a
    // raw `<legacy>` placeholder.
    expect(briefing).toContain('git -C "$legacy" status --porcelain');
    expect(briefing).toContain("merge-base --is-ancestor HEAD origin/<default>");
    // P1 (codex-assistant, PR #1083 follow-up): the retire also destroys
    // local-only history the working-tree/HEAD checks don't see — branches not
    // checked out in any worktree, and stashes. Guard those too before delete.
    expect(briefing).toContain('git -C "$legacy" branch --no-merged origin/<default>');
    expect(briefing).toContain('git -C "$legacy" stash list');
    expect(briefing).toContain("only after ALL of the above are clear");
    // P0 (issue #1086): the final destructive action is a reversible quarantine
    // move, not an in-place irreversible `rm -rf`; deletion is a separate
    // human-confirmed step.
    expect(briefing).toContain('mv -- "$legacy" "$legacy.retired.$(date +%Y%m%d%H%M%S)"');
    expect(briefing).not.toContain("rm -rf <legacy>");
    expect(briefing).toContain("a separate step a human confirms");
    // The context-tree symlink case points at the existing Tree Location block.
    expect(briefing).toMatch(/`context-tree` \*\*symlink\*\* migrates the same/);
  });

  it("preflight canon_url collapses .git / https / http / ssh / git / scp origin forms for the same repo but not a different one (issue #1086)", () => {
    const briefing = buildAgentBriefing(
      makeOpts({
        sourceRepos: [{ absolutePath: `${AGENT_HOME}/source-repos/api`, url: "https://github.com/org/api" }],
      }),
    );
    // Extract the shipped `canon_url` shell function verbatim from the recipe
    // and exercise it — a string assertion alone cannot prove the transport
    // forms actually collapse. codex-assistant (PR #1087) asked for a test that
    // accepts equivalent SSH/HTTPS origins while still rejecting a different repo.
    // Use plain indexOf/slice rather than a regex — a backtracking pattern over
    // the (analysis-uncontrolled) briefing string trips the ReDoS check.
    const fnStart = briefing.indexOf("canon_url() {\n");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const fnEnd = briefing.indexOf("\n}", fnStart);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const canonFn = briefing.slice(fnStart, fnEnd + 2);

    // Run the shipped function from a script file with the URL passed as a
    // positional argument — never interpolated into a shell command string — so
    // the test exercises the real `sed` pipeline without constructing a command
    // from a variable (which a static-analysis command-injection check flags).
    const dir = mkdtempSync(join(tmpdir(), "canon-url-"));
    try {
      const scriptPath = join(dir, "canon.sh");
      writeFileSync(scriptPath, `${canonFn}\ncanon_url "$1"\n`);
      const canon = (url: string): string => execFileSync("sh", [scriptPath, url], { encoding: "utf8" }).trim();

      const key = canon("https://github.com/agent-team-foundation/first-tree.git");
      expect(key).toBe("github.com/agent-team-foundation/first-tree");
      const sameRepo = [
        "https://github.com/agent-team-foundation/first-tree.git",
        "https://github.com/agent-team-foundation/first-tree",
        "http://github.com/agent-team-foundation/first-tree",
        "git@github.com:agent-team-foundation/first-tree.git",
        "git@github.com:agent-team-foundation/first-tree",
        "ssh://git@github.com/agent-team-foundation/first-tree.git",
        "git://github.com/agent-team-foundation/first-tree.git",
      ];
      for (const url of sameRepo) {
        expect(canon(url), `expected ${url} to canonicalize to ${key}`).toBe(key);
      }
      // Genuinely different repos must NOT collapse to the same canonical key —
      // canonicalization stays fail-closed (no false-accept of another repo).
      expect(canon("https://github.com/agent-team-foundation/other")).not.toBe(key);
      expect(canon("git@gitlab.com:agent-team-foundation/first-tree.git")).not.toBe(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits the Source Repositories block when no repos are predeclared", () => {
    const briefing = buildAgentBriefing(makeOpts({ sourceRepos: [] }));
    expect(briefing).not.toContain("## Source Repositories");
    // The Worktrees block still appears though (agent may clone ad-hoc
    // repos that still follow the convention).
    expect(briefing).toContain("## Worktrees");
  });

  it("emits Communication, Workspace Collaboration, Asking Humans, Chat Topic & Description, and CLI Overview subsections", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## Communication");
    // Action classification (the 07:22 root fix): reply transport is framed as
    // a real command you run with the chat CLI (binds "reply" to executing a
    // command, per real-agent QA 2026-06-26), and stated as a principle so a
    // "hold off / discuss only" instruction scopes business actions and never
    // suppresses the reply.
    expect(briefing).toMatch(/is\s+a real command you run with the chat CLI/i);
    expect(briefing).toMatch(/running it delivers your words to a teammate/i);
    expect(briefing).toMatch(/A business action\s+is anything that changes the workspace or the world/i);
    expect(briefing).toMatch(/hold off from acting/i);
    // Communication routing: `chat send` reaches any teammate (a plain send to a
    // human is a free reply); a human also has `chat ask` (decisions) and
    // `chat update --description` (progress). The courtesy-send guard prevents
    // echo loops.
    expect(briefing).toMatch(/\*\*Asking a human\*\*/);
    expect(briefing).toMatch(/\*\*Reporting progress to a human\*\*/);
    expect(briefing).toMatch(/\*\*Reaching an agent to make them act\*\*/);
    // A human-directed message gets a required reply, gathered into ONE concise
    // message. The human-vs-agent asymmetry is explicit: a human never auto-wakes
    // from a reply (no loop risk in answering), and the courtesy-send brake is
    // scoped to agents only.
    expect(briefing).toContain("Replying to a human is required, not optional");
    expect(briefing).toContain("no loop risk in always answering");
    // The send/ask boundary routes by dependency, not importance: a send is
    // self-sufficient (readable, then ignorable); a turn that ends blocked on
    // the human ends with a `chat ask` — a blocking question never rides in a
    // plain send (liuchao-001 2026-07-06).
    expect(briefing).toMatch(/A send must be self-sufficient/);
    expect(briefing).toMatch(/never a send with a blocking question\s+folded in/);
    expect(briefing).toMatch(/Route by\s+dependency, not importance/);
    expect(briefing).toMatch(/This brake is for agents/);
    // Anti-spam discipline: at most one plain human reply per turn; ongoing
    // progress goes to `chat update --description`. The only skip-the-reply case
    // is a re-delivery / no-op wake-up, NOT a fresh human message judged "covered".
    expect(briefing).toContain("Don't stream a human through repeated");
    expect(briefing).toContain("at most one plain human reply");
    expect(briefing).toMatch(/skip a human reply entirely is a turn/);
    expect(briefing).toMatch(/not merely because you judge a fresh/);
    // A decision the human must make goes through `chat ask`, not a plain send.
    expect(briefing).toMatch(/must decide, approve, or answer before you proceed/);
    expect(briefing).toContain("chat invite <name>");
    expect(briefing).toContain("stage or role handoff inside the same task stays in this chat");
    expect(briefing).toMatch(/\*\*Starting separate work\*\*/);
    expect(briefing).toMatch(/chat create --to <name>/);
    expect(briefing).toContain("After an agent handoff, continue only independent work");
    expect(briefing).toContain("do not poll status");
    expect(briefing).toContain("Don't fire a courtesy");
    expect(briefing).not.toContain("**Fallback**");

    expect(briefing).toContain("## Workspace Collaboration");
    expect(briefing).toContain("first-tree chat --help");

    expect(briefing).toContain("## Asking Humans");
    // Asking Humans prescribes `chat ask` (the request mechanism moved off
    // `chat send`). The ask schema is body-is-the-ask + optional `--options`
    // JSON (NOT the retired `--question`/`--option`/`--close` flags). `chat ask`
    // is ask-ONLY: the human resolves in the web UI, so the briefing carries no
    // CLI resolution flag.
    expect(briefing).toMatch(/chat ask <human>/);
    expect(briefing).toContain("body IS the ask");
    expect(briefing).toContain("--options");
    expect(briefing).toContain("--multi-select");
    expect(briefing).toMatch(/cannot.*mark a question answered or close it/i);
    expect(briefing).not.toContain("--answer");
    expect(briefing).not.toContain("--question");
    expect(briefing).not.toContain("--close");
    // Usage discipline: importance governs whether a question should exist at
    // all (never manufacture progress / permission checks); dependency governs
    // routing — a genuine blocking question is ALWAYS an ask, never a question
    // folded into a plain send (liuchao-001 2026-07-06).
    expect(briefing).toMatch(/The routing test is \*\*dependency, not importance\*\*/);
    expect(briefing).toMatch(/genuinely the user's to make/);
    expect(briefing).toMatch(/Do NOT manufacture progress or[\s\n]+permission checks/);
    expect(briefing).toContain("can I continue?");
    // The ask body is decision-self-sufficient: three fixed markdown sections
    // a human who remembers nothing of this chat can decide from — they run
    // many chats in parallel, and a future cross-chat review surface may show
    // the ask alone, outside the chat.
    // Section labels match the example headings exactly (a future cross-chat
    // ask-review surface may parse them): Why this question exists / Recent
    // context / The question.
    expect(briefing).toContain("decision-self-sufficient");
    expect(briefing).toContain("Why this question exists");
    expect(briefing).toContain("Recent context");
    expect(briefing).toMatch(/\*\*The question\*\* — ONE question, plus your recommendation/);

    expect(briefing).toContain("## Chat Topic & Description");
    expect(briefing).toContain("first-tree chat update");
    // The block documents updating the description independently through
    // `chat update`, and carries the upgraded description discipline keys
    // (human-facing status report + Markdown), with set-topic kept as a
    // deprecated alias.
    expect(briefing).toContain("chat update --description");
    expect(briefing).toMatch(/status report/);
    expect(briefing).toMatch(/deprecated alias/);
    expect(briefing).toMatch(/Self-locate/);
    expect(briefing).toContain("Once set, leave the topic unchanged");
    expect(briefing).toContain("stable topic helps humans find the chat");
    expect(briefing).not.toContain("Rename only");
    expect(briefing).not.toContain("subject itself changed");
    // The Chat Topic block points at provider-injected per-chat context, not
    // a block written into this shared briefing file.
    expect(briefing).toContain('provider-injected "Current Chat Context"');
    expect(briefing).not.toContain("bottom of this briefing");
  });

  it("emits the GitHub Entity Attention block with the follow-after-create default inline (not skill-gated)", () => {
    // Why inline: see the githubAttentionBlock comment in agent-briefing.ts.
    const briefing = buildAgentBriefing(makeOpts()); // tree-less default
    expect(briefing).toContain("## GitHub Entity Attention");
    // Default posture: follow what you create, immediately.
    expect(briefing).toContain("**Default: follow what you create.**");
    expect(briefing).toContain("first-tree github follow <url>");
    // The single exception: clearly unrelated to the chat's task.
    expect(briefing).toMatch(/clearly unrelated to this\s+chat's task/);
    // Unfollow is human-explicit-stop only, not a PR/Issue completion ritual.
    expect(briefing).toContain("first-tree github unfollow <entity>");
    expect(briefing).toMatch(/human explicitly asks to stop tracking/);
    expect(briefing).toMatch(/Do not proactively unfollow\s+merely because a PR or Issue completed/);
    // Creation never auto-follows — the extractor is gone (#979).
    expect(briefing).toMatch(/there\s+is no auto-binding/);
  });

  it("emits the GitHub working posture before entity-follow rules", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).toContain("## GitHub Working Posture");
    expect(briefing.indexOf("## GitHub Working Posture")).toBeLessThan(briefing.indexOf("## GitHub Entity Attention"));
    expect(briefing).toContain("try the host `gh` CLI first");
    expect(briefing).toContain("GitHub URLs are not, by themselves, a reason to ask for First Tree GitHub App");
    expect(briefing).toContain("Ask for First Tree GitHub access only when the desired outcome needs platform");
    expect(briefing).toContain("If the current member is not an org admin");
    expect(briefing).toContain("do not ask them to install the");
    expect(briefing).toContain("Do not use agent-accessible local files or tree snapshots as a hidden server");
  });

  it("keeps the GitHub Entity Attention full-guide pointer on CLI help", () => {
    const treeless = buildAgentBriefing(makeOpts());
    expect(treeless).not.toContain("`first-tree-github` skill");
    expect(treeless).toContain("first-tree github follow --help");

    const treeBound = buildAgentBriefing(makeOpts({ contextTreePath: "/var/lib/context-trees/example" }));
    expect(treeBound).not.toContain("`first-tree-github` skill");
    expect(treeBound).toContain("first-tree github follow --help");
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
    // `tree` is scoped to registered concrete subcommands rather than
    // `tree …`; `org` is operator-only and was removed from the
    // agent-facing table in the same edit.
    const overview = briefing.slice(briefing.indexOf("## CLI Overview"));
    expect(overview).toContain("first-tree chat …");
    expect(overview).toContain("first-tree agent …");
    expect(overview).toContain("first-tree daemon …");
    expect(overview).toContain("first-tree github …");
    expect(overview).toContain("first-tree tree verify");
    expect(overview).toContain("first-tree tree tree");

    // Retired / unregistered surface must NOT appear.
    expect(overview).not.toContain("github scan");
    // The old `tree …` catch-all row must not have come back — agents
    // following it would try retired subcommands.
    expect(overview).not.toContain("first-tree tree …");
  });

  it("CLI Overview lists only registered `tree` subcommands — retired commands must stay out", () => {
    // Post-2026-06 the `tree` namespace was retired to concrete
    // registered subcommands: `verify` for validation and `tree` for
    // hierarchy browsing. The briefing's CLI Overview must NOT advertise
    // any deleted subcommand or the agent will burn a turn on `unknown
    // command`. This test is the runtime counterpart to the
    // `command-registration-smoke` test that pins the actual registered
    // surface.
    const briefing = buildAgentBriefing(makeOpts());
    const overview = briefing.slice(briefing.indexOf("## CLI Overview"));

    // The surviving subcommands must be listed.
    expect(overview).toContain("tree verify");
    expect(overview).toContain("tree tree");

    // Every retired tree subcommand must NOT appear in the CLI Overview
    // text. Use word-boundary regex (not `.toContain`) so prose like
    // "workspace ↔ tree binding" doesn't false-positive on `tree bind`.
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
      // Match `first-tree tree <retired>` or `ft tree <retired>` followed
      // by a word boundary (so `tree bind` does NOT match `tree binding`).
      const re = new RegExp(`\\b(?:first-tree|ft)\\s+tree\\s+${retired}\\b`, "u");
      expect(overview, `CLI Overview must not advertise retired \`tree ${retired}\``).not.toMatch(re);
    }
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
    expect(briefing).toContain("load `first-tree-read`");
    expect(briefing).toContain("hierarchy command");
    // Reading the Tree must also point the agent at root `AGENTS.md` when
    // present — orgs put mandatory rules there and the de-injection
    // direction would otherwise lose them silently. The check anchors on
    // the conditional phrasing rather than the bare filename so it can't
    // accidentally pass on a hit elsewhere in the briefing (e.g. the
    // legacy "`AGENTS.md`" string in someone's `prompt.append`).
    expect(briefing).toMatch(/If the root also contains an `AGENTS\.md`, ?\s*read it too/);
    expect(briefing).toContain("mandatory rules the org expects every agent");
    expect(briefing).toContain("before you act on any instruction");
    expect(briefing).toContain("the tree wins");
    expect(briefing).toContain("eagerly, not lazily");

    // Writing discipline anchors — fresh vs persistent context framing, the
    // co-open + cross-link PR coordination rule, and the tightened merge
    // order: the tree PR opens as a draft so it can't land ahead, the code PR
    // merges first, then the tree PR is reconciled against the final merged
    // code and marked ready. The prose wraps the emphasised phrases across
    // lines, so allow either single-line or wrapped forms.
    expect(briefing).toContain("fresh context");
    expect(briefing).toMatch(/\*\*persistent[\s\n]+context\*\*/);
    expect(briefing).toMatch(
      /open the tree PR and the code[\s\n]+PR[\s\n]+together and cross-link them in the PR descriptions/,
    );
    expect(briefing).toMatch(/Merge the code PR first, then[\s\n]+the tree PR/);
    expect(briefing).toMatch(/open the tree PR as a draft/);
    expect(briefing).toContain("final merged");
    expect(briefing).not.toContain("need not merge first");
    expect(briefing).toContain("Implementation-only changes skip the tree");

    // Tree path interpolated under Tree Location.
    expect(briefing).toContain(treePath);
  });

  it("Writing the Tree routing table only references shipped skills", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const writingBlock = briefing.slice(briefing.indexOf("## Writing the Tree"));

    // The surviving rows must point at shipped skills.
    expect(writingBlock).toContain("`first-tree-write`");

    // Retired skills must not appear:
    //   - `first-tree-context` was replaced by `first-tree-write`.
    //   - `first-tree-sync` has no shipped replacement in this pass.
    //   - `first-tree-onboarding` was retired with the old tree
    //     provisioning commands.
    //   - `first-tree-github-scan` predates both and never shipped.
    expect(writingBlock).not.toContain("`first-tree-context`");
    expect(writingBlock).not.toContain("`first-tree-sync`");
    expect(writingBlock).not.toContain("`first-tree-onboarding`");
    expect(writingBlock).not.toContain("`first-tree-github-scan`");
  });

  it("substitutes a tree-less Tree Location stub that surfaces the gap to a human", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    // Section header still emitted so the briefing's # Context Tree always
    // contains all four subsections — predictable for the agent and for
    // section-order assertions above.
    expect(briefing).toContain("## Tree Location");
    const treeLocationStart = briefing.indexOf("## Tree Location");
    const stub = briefing.slice(treeLocationStart);
    expect(stub).toContain("This agent has no Context Tree bound");
    expect(stub).toContain("surface that\ngap to a human");
    expect(stub).toContain("operator action");
    // The retired onboarding skill must not be named — there is no
    // in-agent flow to bind a workspace anymore.
    expect(stub).not.toContain("first-tree-onboarding");
  });

  it("shell-quotes interpolated branch / URL / path in the Tree Location clone command (S5)", () => {
    // baixiaohang #4 / S5: branch / URL / tree path can legitimately carry
    // spaces, `$`, or other shell metacharacters (e.g. a `feature with space`
    // branch, a `release/$VERSION` branch, a path under a username with a
    // dot). Without quoting, a literal copy-paste of the briefing's `git
    // clone` line either parses wrong (extra positional args) or expands a
    // shell variable that is empty / wrong on the agent's host.
    const briefing = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/var/lib/context trees/example",
        contextTreeRepoUrl: "https://example.com/release/$VERSION.git",
        contextTreeBranch: "feature with space",
      }),
    );
    const treeLocation = briefing.slice(briefing.indexOf("## Tree Location"));

    // The clone command lives inside an indented code block — match against
    // its single-quoted form. The interpolated branch must NOT appear bare
    // (which would let the shell split on the space).
    expect(treeLocation).toContain(
      "git clone --branch 'feature with space' --single-branch 'https://example.com/release/$VERSION.git' '/var/lib/context trees/example'",
    );
    // The path also flows into the `rm` / `pull` / `worktree add` snippets —
    // every interpolated absolute path must be single-quoted there too.
    expect(treeLocation).toContain("rm '/var/lib/context trees/example'");
    expect(treeLocation).toContain("git -C '/var/lib/context trees/example' pull --ff-only");
    expect(treeLocation).toContain("git -C '/var/lib/context trees/example' worktree add");
  });

  it("escapes an embedded single quote in the Tree Location quoted values (S5 edge)", () => {
    // POSIX-safe single quoting closes the quoted block, inserts an escaped
    // quote, then reopens — verify the canonical `'\''` form lands in the
    // briefing for a branch / path that already contains a quote.
    const briefing = buildAgentBriefing(
      makeOpts({
        contextTreePath: "/tmp/it's-fine",
        contextTreeRepoUrl: "https://example.com/x.git",
        contextTreeBranch: "main",
      }),
    );
    const treeLocation = briefing.slice(briefing.indexOf("## Tree Location"));
    expect(treeLocation).toContain("'/tmp/it'\\''s-fine'");
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

  it("emits a core-skills First Tree Family map for tree-less agents (routes the tree-build task to first-tree-seed)", () => {
    // A tree-less agent now carries the core skills on disk (welcome + the
    // from-zero build pair seed/write), so the map lists exactly those — and
    // NOT `first-tree-read`, which stays tree-bound. This is the routing
    // surface a welcome-spawned tree-build chat uses to reach first-tree-seed,
    // whose brief names no skill by design.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    expect(briefing).toContain("# Skills (First Tree Managed)");
    const familyStart = briefing.indexOf("## First Tree Family");
    expect(familyStart).toBeGreaterThanOrEqual(0);
    // Bound the assertion to the map's own block (up to the next heading) so a
    // later section that legitimately mentions read can't taint the check.
    const afterStart = briefing.slice(familyStart + "## First Tree Family".length);
    const nextHeadingRel = afterStart.search(/\n#{1,3} /);
    const familyMap = nextHeadingRel === -1 ? afterStart : afterStart.slice(0, nextHeadingRel);
    expect(familyMap).toContain("first-tree-welcome");
    expect(familyMap).toContain("first-tree-seed");
    expect(familyMap).toContain("first-tree-write");
    expect(familyMap).not.toContain("first-tree-read");
    // Tree-less map must not lean on the (omitted) # Required Reading section.
    expect(familyMap).not.toContain("# Required Reading");
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
    // The tree-less core-skills First Tree Family map is also emitted now, and
    // sits after Team Skills under the shared `# Skills` umbrella.
    expect(briefing).toContain("## First Tree Family");
    const skills = briefing.slice(briefing.indexOf("# Skills"));
    expect(skills.indexOf("## Team Skills")).toBeLessThan(skills.indexOf("## First Tree Family"));
  });
});

describe("buildAgentBriefing — provider-injected Current Chat Context boundary", () => {
  it("never writes per-chat Current Chat Context into the shared briefing", () => {
    const briefing = buildAgentBriefing(makeOpts());
    expect(briefing).not.toContain("## Current Chat Context");
    expect(briefing).not.toContain("Chat ID:");
    expect(briefing).not.toContain("Participants:");
  });
});
