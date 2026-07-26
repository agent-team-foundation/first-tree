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
  it("get-started's title/why stay empty (the fork renders per-sub-state headings itself)", () => {
    expect(STEP_COPY["get-started"].title).toBe("");
    expect(STEP_COPY["get-started"].why).toBe("");
  });
});

describe("get-started fork copy", () => {
  it("frames two parallel choices, not a fallback for people without a computer", () => {
    const g = COPY.getStarted;
    // The quick start is a peer choice; banned framings would demote it to an
    // escape hatch ("no computer?") or coin a new product noun.
    for (const s of [g.chooseTitle, g.chooseWhy, g.own.title, g.own.description, g.quick.title, g.quick.description]) {
      expect(s.toLowerCase()).not.toContain("no computer");
      expect(s.toLowerCase()).not.toContain("runtime");
    }
    // Descriptive ownership tag, not a new concept name.
    expect(g.runBy("Zhang Wei")).toBe("Run by Zhang Wei");
    // Quick start must not claim setup is finished.
    expect(g.pickFootnote).toContain("won't finish your setup");
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

  it("shows one plain launch subtitle across every start-chat state", () => {
    // The finale intentionally reads the same regardless of role or team/tree
    // state: that state is invisible to the user (Context Tree is introduced
    // later, in chat), so the subtitle stays a single plain launch line.
    const launch = "Your agent's ready. Start a chat and it'll help you get going.";
    expect(COPY.startChat.noProjectBody).toBe(launch);
    expect(COPY.startChat.inviteeReadyBody).toBe(launch);
    expect(COPY.invitee.notReadyBody).toBe(launch);
    expect(COPY.startChat.newWhy(1)).toBe(launch);
    expect(COPY.startChat.existingWhy(3)).toBe(launch);
  });

  it("keeps the launch subtitle free of the Context Tree concept", () => {
    // Requirement: don't name "context" on this screen — it's taught later in chat.
    for (const s of [COPY.startChat.noProjectBody, COPY.startChat.inviteeReadyBody, COPY.invitee.notReadyBody]) {
      expect(s.toLowerCase()).not.toContain("context");
    }
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
