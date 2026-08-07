import { describe, expect, it } from "vitest";
import { COPY, STEP_COPY } from "../copy.js";

describe("STEP_COPY", () => {
  it("uses canonical setup step titles for user-facing pages", () => {
    expect(STEP_COPY["create-team"].title).toBe("Create a First Tree team");
    expect(STEP_COPY["connect-computer"].title).toBe("Connect this computer");
    expect(STEP_COPY["create-agent"].title).toBe("Create your First Tree agent");
  });

  it("explains the First Tree team concept on the opening step", () => {
    const teamConcept = "A First Tree team is where you, your teammates, and your agents work together.";
    expect(STEP_COPY["create-team"].why).toBe(teamConcept);
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

describe("get-started progressive copy", () => {
  it("leads with personal setup and keeps alternatives behind explicit continuation", () => {
    const g = COPY.getStarted;
    for (const s of [
      g.recommendedTitle,
      g.recommendedWhy,
      g.continueWithout,
      g.pickTitle,
      g.pickWhy,
      g.byo.description,
      g.byo.cta,
    ]) {
      expect(s.toLowerCase()).not.toContain("no computer");
      expect(s.toLowerCase()).not.toContain("runtime");
    }
    expect(g.joinedTeam("Acme")).toBe("You've joined Acme");
    expect(g.recommendedTitle).toBe("Set up your First Tree agent");
    expect(g.personalSteps).toEqual(["Connect computer", "Create agent", "Meet your agent"]);
    expect(g.continueWithout).toBe("Continue without my own agent");
    expect(g.runBy("Zhang Wei")).toBe("Run by Zhang Wei");
    expect(g.teamAgentExecution("Zhang Wei")).toContain("Zhang Wei's connected computer");
    expect(g.byo.cta).toBe("Use the Context Tree in Claude Code or Codex");
    expect(g.byo.description).toContain("one local project");
    expect(g.byoBoundary).toContain("does not create a First Tree agent");
    expect(g.byoBoundary).toContain("outside First Tree Chat");
    expect(g.byoSetupWhy).toContain("paste one prompt");
    expect(g.byoPromptTitle).toBe("Setup prompt");
    expect(g.byoPromptMeta("Codex", "Acme")).toBe("Codex for Acme");
    expect(g.byoPromptSummary).toContain("enables Team Context");
    expect(g.byoPasteToContinue("Codex")).toContain("Paste into Codex");
  });
});

describe("onboarding vocabulary (connect-agent reframe)", () => {
  // The reframe retires "runtime" from UI copy in favour of plain descriptions
  // and the detected option's own name. Guard against it creeping back into
  // the two steps that used to say it.
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

  it("explains the computer action without inventing a category users must learn", () => {
    expect(COPY.connectComputer.whyWaiting).toBe(
      "Install the First Tree app to connect this computer and detect what your agents can run.",
    );
    expect(COPY.connectComputer.whyConnected).toBe("");
    expect(COPY.connectComputer.detectedLabel).toBe("Available on this computer");
    expect(COPY.connectComputer.detectedBridge).toBe("Next, create your First Tree agent.");
    expect(STEP_COPY["create-agent"].title).toContain("First Tree agent");
    expect(COPY.createAgent.subtitle).toBe(
      "Build your own group of agents for different work in this team. Let’s create your first one.",
    );
    expect(COPY.createAgent.codingAgentLabel).toBe("This agent will run");
  });

  it("anchors the finale on the exact agent and explains the next action", () => {
    expect(COPY.startChat.eyebrow).toBe("YOUR FIRST TREE AGENT");
    expect(COPY.startChat.title("Nova")).toBe("Meet Nova");
    expect(COPY.startChat.body("Nova")).toBe(
      "Nova is ready to explore First Tree with you. Bring a question, a project, or a task you want to move forward.",
    );
    expect(COPY.startChat.meetAgent).toBe("Meet your agent");
    expect(COPY.startChat.nextStepHint).toBe("You’ll open your first Chat and can start typing right away.");
    expect(COPY.startChat.starting).toBe("Opening your first Chat…");
  });

  it("keeps the arrival body free of the Context Tree concept", () => {
    // Requirement: don't name "context" on this screen — it's taught later in chat.
    expect(COPY.startChat.body("Nova").toLowerCase()).not.toContain("context");
  });

  it("does not overpromise repo access on start-chat screens", () => {
    const strings = [COPY.startChat.body("Nova")];

    for (const s of strings) {
      expect(s).not.toContain("It'll read your");
      expect(s).not.toContain("read your repo");
      expect(s).not.toContain("No code is connected");
    }
  });
});
