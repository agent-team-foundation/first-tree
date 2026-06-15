import type { Agent, MeChatRow } from "@first-tree/shared";
import { useState } from "react";
import { CommandPalette } from "./workspace/palette/command-palette.js";

/**
 * DEV-only visual review for the Workspace topbar CommandPalette.
 *
 * This preview injects fixed data into the production palette component so UI
 * review does not depend on staging having enough chats or teammates. It is
 * registered only behind `import.meta.env.DEV` in `app.tsx`.
 */

const SELF_ID = "preview-human";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function teammate(overrides: Partial<Agent>): Agent {
  return {
    uuid: overrides.uuid ?? "preview-agent",
    name: overrides.name ?? "preview",
    displayName: overrides.displayName ?? "Preview Agent",
    type: overrides.type ?? "agent",
    managerId: overrides.managerId ?? "preview-member",
    visibility: overrides.visibility ?? "organization",
    avatarColorToken: overrides.avatarColorToken ?? null,
    avatarImageUrl: overrides.avatarImageUrl ?? null,
    status: overrides.status ?? "active",
    organizationId: overrides.organizationId ?? "preview-org",
    delegateMention: overrides.delegateMention ?? null,
    inboxId: overrides.inboxId ?? `${overrides.uuid ?? "preview-agent"}-inbox`,
    metadata: overrides.metadata ?? {},
    source: overrides.source ?? "portal",
    clientId: overrides.clientId ?? null,
    runtimeProvider: overrides.runtimeProvider ?? "claude-code",
    runtimeState: overrides.runtimeState ?? "idle",
    createdAt: overrides.createdAt ?? minutesAgo(10_000),
    updatedAt: overrides.updatedAt ?? minutesAgo(12),
  };
}

const TEAMMATES: Agent[] = [
  teammate({ uuid: SELF_ID, name: "gandy", displayName: "Gandy", type: "human" }),
  teammate({ uuid: "agent-codex", name: "gandy-coder", displayName: "gandy-coder", runtimeProvider: "codex" }),
  teammate({ uuid: "agent-claude", name: "gandy-assistant", displayName: "gandy-assistant" }),
  teammate({ uuid: "agent-design", name: "design-review", displayName: "Design Review" }),
  teammate({ uuid: "agent-release", name: "release-captain", displayName: "Release Captain" }),
  teammate({ uuid: "agent-docs", name: "docs-writer", displayName: "Docs Writer" }),
  teammate({ uuid: "agent-qa", name: "qa-runner", displayName: "QA Runner" }),
  teammate({ uuid: "agent-research", name: "research", displayName: "Research" }),
];

function participant(agent: Agent): MeChatRow["participants"][number] {
  return {
    agentId: agent.uuid,
    displayName: agent.displayName,
    type: agent.type === "human" ? "human" : "agent",
    avatarColorToken: agent.avatarColorToken,
    avatarImageUrl: agent.avatarImageUrl,
  };
}

const SELF = participant(TEAMMATES[0] ?? teammate({ uuid: SELF_ID }));
const CODER = participant(TEAMMATES[1] ?? teammate({ uuid: "agent-codex" }));
const ASSISTANT = participant(TEAMMATES[2] ?? teammate({ uuid: "agent-claude" }));
const DESIGN = participant(TEAMMATES[3] ?? teammate({ uuid: "agent-design" }));
const RELEASE = participant(TEAMMATES[4] ?? teammate({ uuid: "agent-release" }));
const DOCS = participant(TEAMMATES[5] ?? teammate({ uuid: "agent-docs" }));
const QA = participant(TEAMMATES[6] ?? teammate({ uuid: "agent-qa" }));
const RESEARCH = participant(TEAMMATES[7] ?? teammate({ uuid: "agent-research" }));

function chat(overrides: Partial<MeChatRow>): MeChatRow {
  const participants = overrides.participants ?? [SELF, CODER];
  return {
    chatId: overrides.chatId ?? "preview-chat",
    type: overrides.type ?? (participants.length > 2 ? "group" : "direct"),
    membershipKind: overrides.membershipKind ?? "participant",
    createdByMe: overrides.createdByMe ?? false,
    source: overrides.source ?? "manual",
    entityType: overrides.entityType ?? null,
    title: overrides.title ?? "Preview chat",
    topic: overrides.topic ?? null,
    description: overrides.description ?? null,
    participants,
    participantCount: overrides.participantCount ?? participants.length,
    lastMessageAt: "lastMessageAt" in overrides ? (overrides.lastMessageAt ?? null) : minutesAgo(5),
    lastMessagePreview: overrides.lastMessagePreview ?? null,
    unreadMentionCount: overrides.unreadMentionCount ?? 0,
    openRequestCount: overrides.openRequestCount ?? 0,
    canReply: overrides.canReply ?? true,
    engagementStatus: overrides.engagementStatus ?? "active",
    liveActivity: overrides.liveActivity ?? null,
    failedAgentIds: overrides.failedAgentIds ?? [],
    busyAgentIds: overrides.busyAgentIds ?? [],
    chatHasExplicitMentionToMe: overrides.chatHasExplicitMentionToMe ?? false,
  };
}

const CHATS: MeChatRow[] = [
  chat({
    chatId: "preview-jump-palette",
    title: "Jump to palette polish",
    topic: "Jump to palette polish",
    description: "semantic fixture search target: palette density, teammate roster, archived chip, and recents",
    participants: [SELF, CODER, DESIGN],
    lastMessageAt: minutesAgo(2),
  }),
  chat({
    chatId: "preview-ask-user",
    title: "Ask-user dialog review",
    participants: [SELF, ASSISTANT],
    lastMessageAt: minutesAgo(7),
  }),
  chat({
    chatId: "preview-release",
    title: "Release train",
    participants: [SELF, RELEASE, QA],
    lastMessageAt: minutesAgo(18),
  }),
  chat({
    chatId: "preview-docs",
    title: "Docs and tree sync",
    participants: [SELF, DOCS, RESEARCH],
    lastMessageAt: minutesAgo(41),
  }),
  chat({
    chatId: "preview-archived",
    title: "Archived onboarding audit",
    engagementStatus: "archived",
    participants: [SELF, ASSISTANT],
    lastMessageAt: minutesAgo(83),
  }),
  chat({
    chatId: "preview-long-title",
    title: "A very long workspace topic that should truncate cleanly inside a compact command row",
    participants: [SELF, DESIGN],
    lastMessageAt: minutesAgo(110),
  }),
  chat({
    chatId: "preview-untitled",
    title: "",
    topic: null,
    participants: [SELF, QA],
    lastMessageAt: minutesAgo(160),
  }),
  chat({
    chatId: "preview-github",
    title: "Command palette follow-up review",
    source: "github",
    entityType: "pull_request",
    participants: [SELF, CODER],
    lastMessageAt: minutesAgo(230),
  }),
  chat({
    chatId: "preview-cap-rover",
    title: "CapRover feedback route",
    participants: [SELF, RESEARCH],
    lastMessageAt: minutesAgo(300),
  }),
  chat({
    chatId: "preview-runtime",
    title: "Runtime status cards",
    participants: [SELF, ASSISTANT],
    lastMessageAt: minutesAgo(390),
  }),
  chat({
    chatId: "preview-agent-copy",
    title: "Agent profile copy pass",
    participants: [SELF, DOCS],
    lastMessageAt: minutesAgo(520),
  }),
  chat({
    chatId: "preview-context-feed",
    title: "Context feed skip reasons",
    participants: [SELF, RESEARCH],
    lastMessageAt: minutesAgo(720),
  }),
  chat({
    chatId: "preview-old-1",
    title: "Old branch cleanup",
    participants: [SELF, RELEASE],
    lastMessageAt: minutesAgo(1_020),
  }),
  chat({
    chatId: "preview-old-2",
    title: "Design token audit",
    participants: [SELF, DESIGN],
    lastMessageAt: minutesAgo(1_600),
  }),
  chat({
    chatId: "preview-old-3",
    title: "Search backend backlog",
    participants: [SELF, CODER],
    lastMessageAt: minutesAgo(2_400),
  }),
  chat({ chatId: "preview-never", title: "Never messaged seed", participants: [SELF, QA], lastMessageAt: null }),
];

export function CommandPalettePreviewPage() {
  const [open, setOpen] = useState(true);

  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div>
          <h1 className="text-title font-semibold">Command palette preview</h1>
          <p className="text-body text-muted-foreground mt-2">
            DEV fixture route. The palette uses fixed local chats and teammates, not staging data.
          </p>
        </div>
        <button
          type="button"
          className="w-fit rounded-[var(--radius-input)] bg-primary px-3 py-2 text-body text-primary-foreground"
          onClick={() => setOpen(true)}
        >
          Open palette
        </button>
      </div>
      <CommandPalette open={open} onOpenChange={setOpen} demoData={{ chats: CHATS, agents: TEAMMATES }} />
    </div>
  );
}
