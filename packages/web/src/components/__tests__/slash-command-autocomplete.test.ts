import type { SkillDescriptor } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  buildSlashInsert,
  detectSlashTrigger,
  rankSlashCommands,
  resolveMentionContext,
  type SlashCommandItem,
  type SlashSystemCommand,
} from "../slash-command-autocomplete.js";

function sysCmd(name: string, description = ""): SlashSystemCommand {
  return { kind: "system", name, description };
}

function skillItem(name: string, namespace?: string): SlashCommandItem {
  const skill: SkillDescriptor = {
    name,
    description: `desc ${name}`,
    source: "user",
    ...(namespace ? { namespace } : {}),
  };
  return { kind: "skill", skill, agentId: "agt-1", agentDisplayName: "Agent" };
}

describe("detectSlashTrigger", () => {
  it("detects `/` at the very start of the buffer", () => {
    expect(detectSlashTrigger("/re", 3)).toEqual({ triggerIndex: 0, query: "re" });
  });

  it("detects `/` after leading whitespace (tolerates indented composers)", () => {
    expect(detectSlashTrigger("  /he", 5)).toEqual({ triggerIndex: 2, query: "he" });
  });

  it("does NOT trigger on mid-line `/` — slash commands are composer-mode", () => {
    expect(detectSlashTrigger("hi /help", 8)).toBeNull();
  });

  it("does NOT trigger after a `@mention` followed by `/` — slash must be first non-ws char", () => {
    expect(detectSlashTrigger("@reviewer /re", 13)).toBeNull();
  });

  it("returns empty query for a bare `/`", () => {
    expect(detectSlashTrigger("/", 1)).toEqual({ triggerIndex: 0, query: "" });
  });

  it("rejects non-name chars in the query (closes the trigger)", () => {
    expect(detectSlashTrigger("/foo bar", 8)).toBeNull();
  });

  it("accepts namespaced commands (`/plugin:name`)", () => {
    expect(detectSlashTrigger("/hyperframes:gsap", 17)).toEqual({ triggerIndex: 0, query: "hyperframes:gsap" });
  });
});

describe("resolveMentionContext", () => {
  const participants = [
    { agentId: "a", name: "alice", displayName: "Alice" },
    { agentId: "b", name: "bob", displayName: "Bob" },
  ];

  it("picks the most recent mention before the cursor", () => {
    const got = resolveMentionContext("@alice please. @bob /", 21, participants);
    expect(got).toEqual({ agentId: "b", displayName: "Bob" });
  });

  it("ignores mentions after the cursor", () => {
    const got = resolveMentionContext("@alice /  @bob", 8, participants);
    expect(got).toEqual({ agentId: "a", displayName: "Alice" });
  });

  it("returns null when no @<name> resolves", () => {
    expect(resolveMentionContext("hi /", 4, participants)).toBeNull();
    expect(resolveMentionContext("@unknown /", 10, participants)).toBeNull();
  });

  it("falls back to display name when participant has no friendly label", () => {
    const got = resolveMentionContext("@bob /", 6, [{ agentId: "b", name: "bob", displayName: null }]);
    expect(got).toEqual({ agentId: "b", displayName: "bob" });
  });
});

describe("rankSlashCommands", () => {
  const items: SlashCommandItem[] = [
    sysCmd("help"),
    sysCmd("clear"),
    skillItem("review"),
    skillItem("ship"),
    skillItem("gsap", "hyperframes"),
  ];

  it("filters by case-insensitive prefix first", () => {
    const r = rankSlashCommands(items, "he");
    expect(r.map((i) => (i.kind === "system" ? i.name : i.skill.name))).toEqual(["help"]);
  });

  it("prefers prefix matches over substring matches", () => {
    const r = rankSlashCommands([sysCmd("score"), ...items], "re");
    // `score` is a substring match ("re" inside "sCORe" — index 3); `review`
    // is a prefix match. Prefix wins.
    expect(r.map((i) => (i.kind === "system" ? i.name : i.skill.name))).toEqual(["review", "score"]);
  });

  it("system commands win ties with the same score", () => {
    // Both `/clear` (system) and `/cli` (hypothetical) start with `cl`;
    // here we just check the kind-tiebreaker via empty query.
    const r = rankSlashCommands(items, "");
    expect(r.filter((i) => i.kind === "system").length).toBe(2);
    // System block sorts before skills in ties.
    expect(r[0]?.kind).toBe("system");
  });

  it("matches namespaced commands via `namespace:name` key", () => {
    const r = rankSlashCommands(items, "hyperframes:g");
    expect(r.map((i) => (i.kind === "skill" ? i.skill.name : i.name))).toEqual(["gsap"]);
  });
});

describe("buildSlashInsert", () => {
  it("clears the textarea for system commands so they are not sent literally", () => {
    const insert = buildSlashInsert("/he", { triggerIndex: 0, query: "he" }, 3, sysCmd("help"));
    expect(insert).toEqual({ text: "", cursor: 0, kind: "system" });
  });

  it("replaces `/<query>` with `/<name> ` for a skill so the user can type args", () => {
    const insert = buildSlashInsert("/re", { triggerIndex: 0, query: "re" }, 3, skillItem("review"));
    expect(insert.text).toBe("/review ");
    expect(insert.cursor).toBe("/review ".length);
    expect(insert.kind).toBe("skill");
  });

  it("does not double-space when a space already follows the trigger", () => {
    const insert = buildSlashInsert("/re foo", { triggerIndex: 0, query: "re" }, 3, skillItem("review"));
    expect(insert.text).toBe("/review foo");
  });

  it("emits the namespaced literal for plugin skills", () => {
    const insert = buildSlashInsert("/hy", { triggerIndex: 0, query: "hy" }, 3, skillItem("gsap", "hyperframes"));
    expect(insert.text).toBe("/hyperframes:gsap ");
  });
});
