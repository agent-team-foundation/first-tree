import { describe, expect, it } from "vitest";
import { COPY, STEP_COPY } from "../copy.js";

describe("STEP_COPY", () => {
  it("uses canonical setup step titles for user-facing pages", () => {
    expect(STEP_COPY["create-team"].title).toBe("Create a First Tree team");
    expect(STEP_COPY["join-team"].title).toBe("Join the team");
    expect(STEP_COPY["connect-computer"].title).toBe("Connect this computer");
    expect(STEP_COPY["create-agent"].title).toBe("Create your first agent");
  });

  it("explains the First Tree team concept on the opening step", () => {
    const teamConcept = "A First Tree team is where you, your teammates, and your agents work together.";
    expect(STEP_COPY["create-team"].why).toBe(teamConcept);
    expect(STEP_COPY["join-team"].why).toBe(teamConcept);
  });

  it("no step has 'outcomes' (footer removed; merged into why)", () => {
    for (const id of Object.keys(STEP_COPY) as Array<keyof typeof STEP_COPY>) {
      // outcomes was removed from the StepCopy type; any leftover string array
      // would indicate a stale entry that ships dead UI content.
      expect((STEP_COPY[id] as unknown as Record<string, unknown>).outcomes).toBeUndefined();
    }
  });
  it("start-chat's title/why stay empty (the step renders per-sub-state headings itself)", () => {
    expect(STEP_COPY["start-chat"].title).toBe("");
    expect(STEP_COPY["start-chat"].why).toBe("");
  });
});

describe("onboarding vocabulary (connect-agent reframe)", () => {
  // The reframe retires "runtime" from UI copy in favour of "coding agent" /
  // the tool's own name. Guard against it creeping back into the two steps
  // that used to say it.
  it("connect-computer + create-agent copy never says 'runtime'", () => {
    const cc = COPY.connectComputer;
    const ca = COPY.createAgent;
    const strings = [
      STEP_COPY["connect-computer"].title,
      STEP_COPY["create-agent"].title,
      cc.whyWaiting,
      cc.whyConnected,
      cc.waiting,
      cc.connected,
      cc.noRuntime,
      cc.detecting,
      ...cc.stuckReasons,
      cc.tokenErrorTitle,
      ca.subtitle,
      ca.nameLabel,
      ca.creating,
      ca.creatingHint,
      ca.timeoutBody,
      `${ca.computerDisconnected.pre}${ca.computerDisconnected.link}${ca.computerDisconnected.post}`,
    ];
    for (const s of strings) {
      expect(s.toLowerCase()).not.toContain("runtime");
    }
  });

  it("names the coding agent directly once detected", () => {
    expect(COPY.connectComputer.whyWaiting).toContain("Claude Code");
    // create-agent's subtitle intentionally uses the category word ("local
    // coding agent"), not the tool names — the concrete tool is named in the
    // field's pills (PROVIDER_LABEL) instead.
    expect(COPY.createAgent.subtitle).toContain("local coding agent");
  });

  it("keeps the start-chat finale action-oriented and consistent", () => {
    expect(COPY.startChat.newTitle).toBe("Start working with your agent");
    expect(COPY.startChat.existingTitle).toBe("Start working with your agent");
    expect(COPY.startChat.noProjectTitle).toBe("Start working with your agent");
    expect(COPY.startChat.inviteeReadyTitle).toBe("Start working with your agent");
    expect(COPY.invitee.notReadyTitle).toBe("Start working with your agent");

    expect(COPY.startChat.startBuilding).toBe("Start chat");
    expect(COPY.startChat.startExisting).toBe("Start chat");
    expect(COPY.startChat.startChatting).toBe("Start chat");
    expect(COPY.startChat.startWorking).toBe("Start chat");
    expect(COPY.invitee.startAnyway).toBe("Start chat");
  });

  it("frames no-repo start-chat as a normal path, not missing setup", () => {
    expect(COPY.startChat.noProjectBody).not.toContain("No code is connected");
    expect(COPY.startChat.noProjectBody).toContain("Setup is ready");
    expect(COPY.startChat.noProjectBody).toContain("a project path");
    expect(COPY.startChat.noProjectBody).toContain("a GitHub repo URL");
    expect(COPY.startChat.noProjectBody).toContain("the task you want help with");
  });

  it("does not overpromise repo access on start-chat screens", () => {
    const strings = [
      COPY.startChat.newWhy(1),
      COPY.startChat.newWhy(3),
      COPY.startChat.existingWhy(1),
      COPY.startChat.existingWhy(3),
      COPY.startChat.noProjectBody,
      COPY.startChat.inviteeReadyBody,
      COPY.invitee.notReadyBody,
    ];

    for (const s of strings) {
      expect(s).not.toContain("It'll read your");
      expect(s).not.toContain("read your repo");
      expect(s).not.toContain("No code is connected");
    }
  });
});
