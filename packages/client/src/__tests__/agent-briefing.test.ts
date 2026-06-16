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
          description: null,
          participants: [{ name: "alice", displayName: "Alice", type: "human" }],
        },
      }),
    );

    // Per-agent header ordering invariant: every # / ## that is part of the
    // briefing skeleton must appear in this order, with the per-chat
    // `## Current Chat Context` block at the bottom so the prompt cache
    // stays warm across sibling chats.
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
      "## Current Chat Context (First Tree Managed, per-chat)",
    ];
    let last = -1;
    for (const header of expectedOrder) {
      // The generated-file banner precedes every section, so each header —
      // including the first — sits after a newline.
      const idx = briefing.indexOf(`\n${header}\n`, Math.max(last, 0));
      expect(idx, `header "${header}" missing or out of order`).toBeGreaterThan(last);
      last = idx;
    }
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
  // guarantees `first-tree` and `first-tree-context` get loaded on
  // every task — otherwise progressive disclosure (keyword-triggered)
  // can silently skip them and the agent acts without the rules in
  // those skills (daemon lifecycle, tree concept model, hard write
  // rules, etc.).

  it("emits the # Required Reading section for tree-bound agents with MUST framing and both skill names", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));

    expect(briefing).toContain("# Required Reading");
    // Hard-mandate anchors — progressive disclosure is opt-in by
    // default; this block makes the two routing-critical skills
    // mandatory regardless of what the user types.
    expect(briefing).toMatch(/you MUST\s+load both skills below/);
    expect(briefing).toContain("**`first-tree`**");
    expect(briefing).toContain("**`first-tree-context`**");
    // Claude Code's transcript exposes a skill listing, but native skill-body
    // injection is still provider-owned. The briefing must give a direct
    // filesystem fallback so "unconditional" is actionable even when the
    // provider only listed the skill names.
    expect(briefing).toContain(`${AGENT_HOME}/.agents/skills/first-tree/SKILL.md`);
    expect(briefing).toContain(`${AGENT_HOME}/.agents/skills/first-tree-context/SKILL.md`);
    // Bootstrapping framing — the mandate IS the first step of the
    // skill-described pre-task hygiene, not "even before" those
    // checks (which would be self-contradictory: you can't run the
    // checks before you've read the skill that lists them).
    expect(briefing).toMatch(/loading them \*\*is\*\* the first step of the[\s\n]+pre-task hygiene/);
    // Briefing↔skill split: minimum mechanics inline, durable rules
    // in full in the skills. Honest about the partial summarisation
    // (chat send mechanics are in the briefing's Communication block;
    // write-side gate is in `## Writing the Tree`) — the briefing
    // can't claim "not duplicated" without contradicting itself.
    expect(briefing).toMatch(/minimum\s+mechanics you need to operate at all/);
    expect(briefing).toMatch(/durable\s+rules in full/);
    expect(briefing).toMatch(/only summarising the slices/);
    // The cost-of-skipping list names what's actually missing from
    // the inline briefing (the daemon-lifecycle invariants, the full
    // Communication Principles, source-system boundary, Hard Rules +
    // Double Test) — not a blanket "not duplicated" claim.
    expect(briefing).toMatch(/daemon-lifecycle invariants/);
    expect(briefing).toMatch(/Hard Rules \+ Double Test/);
    expect(briefing).toMatch(/either omits or only summarises/);
    // Calls out the on-demand-only sibling so the agent doesn't
    // over-load every First Tree family skill on every task.
    expect(briefing).toContain("`first-tree-read`");
    expect(briefing).toContain("`first-tree-sync`");
  });

  it("places # Required Reading immediately after # Working in First Tree (its CLI Overview tail) and before # Context Tree", () => {
    // Placement rationale: the agent first reads the inline
    // workspace-collab basics (chat send, working directory,
    // communication) it needs to operate at all, then hits the hard
    // mandate to load `first-tree` + `first-tree-context` before any
    // real work. The mandate sits adjacent to `# Context Tree` because
    // those skills cover the shared runtime and tree concept/write
    // rules for that section.
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

  it("omits # Required Reading for tree-less agents (the skill payloads are not installed on disk for them)", () => {
    // `installFirstTreeIntegration` is short-circuited when
    // `contextTreePath === null`, so the SKILL.md payloads under
    // `<workspace>/.agents/skills/` never get materialised. Mandating
    // a load would point at files that aren't there. The Tree
    // Location stub already surfaces the gap to a human.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    expect(briefing).not.toContain("# Required Reading");
  });

  it("flags `first-tree` and `first-tree-context` as unconditional in the ## First Tree Family map (consistent with # Required Reading)", () => {
    // The Skill Map's framing has to match the # Required Reading
    // mandate, otherwise the agent gets contradictory signals
    // (progressive-disclosure-only vs. unconditional). Pin both
    // rows' new "unconditional" label and the head paragraph that
    // calls them out.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const familyMap = briefing.slice(briefing.indexOf("## First Tree Family"));

    // Head paragraph explicitly names both unconditional skills and
    // points back at the # Required Reading anchor.
    expect(familyMap).toMatch(
      /`first-tree` and `first-tree-context` are \*\*unconditional\*\* — load\s+them on every task per `# Required Reading` above\./,
    );

    // Both unconditional rows must carry the "unconditional" label
    // inline so the table is self-explanatory even when read in
    // isolation.
    const firstTreeRow = familyMap.match(/\|\s*`first-tree`\s*\|[^\n]*/)?.[0] ?? "";
    expect(firstTreeRow).toContain("unconditional");
    expect(firstTreeRow).toContain("`# Required Reading`");

    const contextRow = familyMap.match(/\|\s*`first-tree-context`\s*\|[^\n]*/)?.[0] ?? "";
    expect(contextRow).toContain("unconditional");
    expect(contextRow).toContain("`# Required Reading`");
    expect(contextRow).toContain("concept model");
    expect(contextRow).toContain("source-driven tree writes");
    expect(contextRow).not.toContain("read context before acting");

    // On-demand rows must NOT pick up the unconditional label by
    // accident — they're triggered by keyword / task signal.
    const readRow = familyMap.match(/\|\s*`first-tree-read`\s*\|[^\n]*/)?.[0] ?? "";
    expect(readRow).not.toContain("unconditional");
    expect(readRow).toContain("before acting");

    const syncRow = familyMap.match(/\|\s*`first-tree-sync`\s*\|[^\n]*/)?.[0] ?? "";
    expect(syncRow).not.toContain("unconditional");
  });
});

describe("buildAgentBriefing — # Working in First Tree subsections", () => {
  it("emits the runtime intro block with output-stream / chat-send full decoupling, transitional mirror fact, courtesy-send guard, Issue #389", () => {
    const briefing = buildAgentBriefing(makeOpts());

    // Output stream and chat send are two separate channels — the
    // briefing must never tie agent behavior on one to activity on the
    // other. yuezengwu 2026-06-10: "chat send 和 output streaming
    // 完全解耦，不应当有任何互相影响。在系统 message 里记录是过渡状态，
    // 未来 output streaming 不进入 message" — "完全解耦" is the future
    // direction; the briefing must be honest that today's runtime still
    // mirrors the output stream as a transitional system row (the two
    // channels DO interact today via that mirror).
    expect(briefing).toContain("Your output stream is your reasoning trace");
    expect(briefing).toMatch(/separate channel from[\s\n]+`?chat send`?/);
    expect(briefing).toContain("To reach a teammate");
    expect(briefing).toContain("first-tree chat send <name>");
    expect(briefing).toContain("only delivery path you should rely on");

    // Coupling guard — the false present-tense claim "the two never
    // interact" must not appear today (mirror = interaction). The
    // honest framing is "separate channel" today + "two fully decoupled
    // channels" as the future direction (see below).
    expect(briefing).not.toMatch(/never[\s\n]+interact/);

    // Transitional system behavior — the runtime currently mirrors
    // non-empty final output into chat history as a silent
    // `agent-final-text` row that does NOT wake other agents. The
    // briefing acknowledges the fact and names the runtime-retirement
    // track + the "two fully decoupled channels" future direction, but
    // issues NO instruction conditioning the agent's output on chat-
    // send activity (that would re-couple the channels at the agent
    // layer). The note wraps across template-literal lines, so use
    // regex matches that tolerate intra-bullet whitespace / newlines.
    expect(briefing).toMatch(/non-empty[\s\n]+final[\s\n]+output is currently[\s\n]+mirrored/);
    expect(briefing).toContain("agent-final-text");
    expect(briefing).toMatch(/does[\s\n]+NOT[\s\n]+wake other agents/);
    expect(briefing).toMatch(/runtime-retirement[\s\n]+track/);
    expect(briefing).toMatch(/future direction[\s\n]+is[\s\n]+two fully decoupled[\s\n]+channels/);
    expect(briefing).toMatch(/not a reach path/);

    // Coupling guard — these phrasings would condition agent output on
    // chat-send activity. They MUST NOT appear in the briefing under the
    // full-decoupling principle.
    //
    // Note: these are *regression* guards for the specific phrasings the
    // PR removed (ad40745d's "don't restate ..." / "don't rely on ... for
    // delivery"). Principle-level enforcement against *any* future
    // re-coupling phrasing (e.g. "after chat send, keep final output
    // minimal" / "if you just chat-send-ed, end the turn") is human-review
    // only; mechanical guards cannot recognise every paraphrase.
    expect(briefing).not.toMatch(/don't restate/i);
    expect(briefing).not.toMatch(/don't rely on it for delivery/i);

    // Courtesy-send guard (the brake stays on the *send* side, not the
    // output side; result-sink's empty-output guard is a runtime safety
    // belt, not the contract).
    expect(briefing).toContain("Don't fire a courtesy");
    expect(briefing).toContain("end the turn without sending");
    // No bare "output nothing" prescription survives. The transitional
    // mirror is named in the descriptive sentence, not in an instruction
    // that suppresses agent output.
    expect(briefing).not.toMatch(/\boutput nothing\b/);

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
    expect(briefing).toContain("first-tree-sync");
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
    expect(briefing).toContain("rm -rf <legacy>");
    // P1 (Codex, PR #1083): `git worktree remove` refuses a main working tree,
    // so `rm -rf <legacy>` is the only way to drop the legacy checkout itself —
    // the guidance must require clearing the SAME clean + already-merged bar on
    // the checkout's own tree/HEAD before that delete, not just on linked
    // worktrees.
    expect(briefing).toContain("git -C <legacy> status --porcelain");
    expect(briefing).toContain("merge-base --is-ancestor HEAD origin/<default>");
    // P1 (codex-assistant, PR #1083 follow-up): `rm -rf <legacy>` also destroys
    // local-only history the working-tree/HEAD checks don't see — branches not
    // checked out in any worktree, and stashes. Guard those too before delete.
    expect(briefing).toContain("git -C <legacy> branch --no-merged origin/<default>");
    expect(briefing).toContain("git -C <legacy> stash list");
    expect(briefing).toContain("only after ALL of the above are clear");
    // The context-tree symlink case points at the existing Tree Location block.
    expect(briefing).toMatch(/`context-tree` \*\*symlink\*\* migrates the same/);
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
    // Chat-send contract: every teammate reach (human plain / human request /
    // agent) goes through chat send; the courtesy-send guard prevents echo
    // loops without touching the agent's output stream.
    expect(briefing).toMatch(/\*\*Reaching a human in this chat\*\*/);
    expect(briefing).toMatch(/\*\*Asking a human\*\*/);
    expect(briefing).toMatch(/\*\*Reaching an agent to make them act\*\*/);
    expect(briefing).toContain("chat invite <name>");
    expect(briefing).toContain("stage or role handoff inside the same task stays in this chat");
    expect(briefing).toMatch(/\*\*Starting separate work\*\*/);
    expect(briefing).toMatch(/chat create --to <name>/);
    expect(briefing).toContain("After an agent handoff, continue only independent work");
    expect(briefing).toContain("do not poll status");
    expect(briefing).toContain("Don't fire a courtesy");
    expect(briefing).toContain("reasoning trace");
    // Fallback block was retired in the chat-send-contract pass — the
    // contract now is "always chat send for cross-participant", so the
    // "drop to conservative mode" branch is redundant.
    expect(briefing).not.toContain("**Fallback**");

    expect(briefing).toContain("## Workspace Collaboration");
    expect(briefing).toContain("`first-tree` skill");

    expect(briefing).toContain("## Asking Humans");
    // Asking Humans now prescribes the structured request mechanism instead of
    // the old "[pending redesign, 自行判断]" stub.
    expect(briefing).toMatch(/chat send <human> --request/);
    expect(briefing).toContain("--question");

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
    // The Chat Topic block points at the Current Chat Context block at the
    // BOTTOM of the briefing (not "above" as in the pre-restructure
    // copy).
    expect(briefing).toContain("at the\nbottom of this briefing");
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

  it("gates the GitHub Entity Attention full-guide pointer: skill for tree-bound, --help for tree-less", () => {
    // Tree-less agents have no First Tree skill payloads on disk
    // (`installFirstTreeIntegration` is tree-gated), so the block must not
    // point them at `first-tree-github` — same discipline as the gated
    // # Required Reading and First Tree Family map.
    const treeless = buildAgentBriefing(makeOpts());
    expect(treeless).not.toContain("`first-tree-github` skill");
    expect(treeless).toContain("first-tree github follow --help");

    const treeBound = buildAgentBriefing(makeOpts({ contextTreePath: "/var/lib/context-trees/example" }));
    expect(treeBound).toContain("`first-tree-github` skill");
    expect(treeBound).not.toContain("github follow --help");
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

    // Writing discipline anchors — fresh vs persistent context framing and
    // the co-open + cross-link PR coordination rule (the tree PR need not
    // merge before the code PR). The prose wraps the emphasised phrases
    // across lines, so allow either single-line or wrapped forms.
    expect(briefing).toContain("fresh context");
    expect(briefing).toMatch(/\*\*persistent[\s\n]+context\*\*/);
    expect(briefing).toMatch(
      /open the tree PR and the code[\s\n]+PR[\s\n]+together and cross-link them in the PR descriptions/,
    );
    expect(briefing).toMatch(/with[\s\n]+the code PR or shortly after/);
    expect(briefing).toContain("Implementation-only changes skip the tree");

    // Tree path interpolated under Tree Location.
    expect(briefing).toContain(treePath);
  });

  it("Writing the Tree routing table only references shipped skills", () => {
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: "/tree" }));
    const writingBlock = briefing.slice(briefing.indexOf("## Writing the Tree"));

    // The surviving rows must point at shipped skills.
    expect(writingBlock).toContain("`first-tree-context`");
    expect(writingBlock).toContain("`first-tree-sync`");

    // Retired skills must not appear:
    //   - `first-tree-write` was folded into `first-tree-context` under
    //     the simplify-context-skill pass (PR #843).
    //   - `first-tree-onboarding` was retired with the old tree
    //     provisioning commands.
    //   - `first-tree-github-scan` predates both and never shipped.
    expect(writingBlock).not.toContain("`first-tree-write`");
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

  it("omits the First Tree Family map for tree-less agents (skills are gated on `installFirstTreeIntegration`)", () => {
    // A no-tree agent's `tree skill install` never runs, so listing the
    // First Tree family would tell it to load skills that the runtime
    // never put on disk. The map must be gated.
    const briefing = buildAgentBriefing(makeOpts({ contextTreePath: null }));
    expect(briefing).not.toContain("## First Tree Family");
    // And without Team Skills, the bare `# Skills` umbrella is skipped
    // entirely — a header with no body is just visual noise.
    expect(briefing).not.toMatch(/^# Skills\b/m);
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
          description: "implementing the redesign; mockups approved, building components",
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
