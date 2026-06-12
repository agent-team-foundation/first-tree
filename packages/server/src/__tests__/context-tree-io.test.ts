import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { chats } from "../db/schema/chats.js";
import { contextTreeIoEvents } from "../db/schema/context-tree-io-events.js";
import {
  explainContextTreeIoDecision,
  recordFromSessionEvent,
  summarizeContextTreeIo,
  summarizeContextTreeIoSkippedEvents,
} from "../services/context-tree-io.js";
import { putOrgSetting } from "../services/org-settings.js";
import { appendEvent } from "../services/session-event.js";
import { createTestAgent, useTestApp } from "./helpers.js";

const TREE_REPO = "https://github.com/acme/first-tree-context.git";
const TREE_REPO_SSH = "git@github.com:acme/first-tree-context.git";

const getApp = useTestApp();

async function seedContextTreeChat() {
  const app = getApp();
  const seed = await createTestAgent(app);
  await putOrgSetting(
    app.db,
    seed.organizationId,
    "context_tree",
    { repo: TREE_REPO, branch: "main" },
    {
      updatedBy: seed.userId,
    },
  );
  const chatId = `chat-${crypto.randomUUID()}`;
  await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId, type: "direct", topic: "io" });
  return { ...seed, chatId };
}

describe("context-tree IO service", () => {
  it("records legacy context_tree_usage as an idempotent read event", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const persisted = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "context_tree_usage",
      payload: {
        purpose: "design_decision",
        treeRepoUrl: TREE_REPO_SSH,
        nodePath: "domains/runtime/NODE.md",
      },
    });

    const input = {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      runtimeProvider: "claude-code",
      sessionEvent: persisted,
    };
    await recordFromSessionEvent(app.db, input);
    await recordFromSessionEvent(app.db, input);

    const rows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, persisted.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "read",
      source: "legacy_context_tree_usage",
      targetKind: "file",
      targetPath: "domains/runtime/NODE.md",
      treeRepoUrl: TREE_REPO,
    });

    const summary = await summarizeContextTreeIo(app.db, seed.organizationId, 7);
    expect(summary.summary.read).toMatchObject({ agentCount: 1, eventCount: 1, targetCount: 1 });
    expect(summary.summary.write.eventCount).toBe(0);
    expect(summary.recentEvents[0]).toMatchObject({
      action: "read",
      targetPath: "domains/runtime/NODE.md",
      chatId: seed.chatId,
      chatTitle: "io",
      viewerCanAccess: false,
    });
  });

  it("derives validated tool-call write IO from file refs and skips mismatches", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const persisted = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-write",
        name: "file_change",
        args: {},
        status: "ok",
        toolFileRefs: [
          {
            origin: "file_change",
            localPath: "/tmp/tree/members/alice/NODE.md",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "members/alice/NODE.md",
            pathKind: "file",
          },
          {
            origin: "file_change",
            repoUrl: "https://github.com/acme/other.git",
            repoBranch: "main",
            repoRelativePath: "members/bob/NODE.md",
            pathKind: "file",
          },
          {
            origin: "file_change",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "../escape.md",
            pathKind: "file",
          },
        ],
      },
    });

    await recordFromSessionEvent(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      runtimeProvider: "codex",
      sessionEvent: persisted,
    });

    const rows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, persisted.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "write",
      source: "codex_file_change",
      sourceIndex: 0,
      targetPath: "members/alice/NODE.md",
      runtimeProvider: "codex",
    });

    const summary = await summarizeContextTreeIo(app.db, seed.organizationId, 7);
    expect(summary.summary.write).toMatchObject({ agentCount: 1, eventCount: 1, targetCount: 1 });
    expect(summary.agents[0]).toMatchObject({ readCount: 0, writeCount: 1, runtimeProvider: "codex" });
  });

  it("derives Claude read and write source from tool name, not client-provided action", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const read = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-read",
        name: "Read",
        args: {},
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "domains/runtime/NODE.md",
            pathKind: "file",
          },
        ],
      },
    });
    const write = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-write",
        name: "Write",
        args: {},
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "domains/runtime/NODE.md",
            pathKind: "file",
          },
        ],
      },
    });

    for (const persisted of [read, write]) {
      await recordFromSessionEvent(app.db, {
        organizationId: seed.organizationId,
        agentId: seed.agent.uuid,
        chatId: seed.chatId,
        runtimeProvider: "claude-code",
        sessionEvent: persisted,
      });
    }

    const rows = await app.db.select().from(contextTreeIoEvents).where(eq(contextTreeIoEvents.chatId, seed.chatId));
    expect(rows).toHaveLength(2);
    expect(
      rows.map((row) => ({ action: row.action, source: row.source })).sort((a, b) => a.source.localeCompare(b.source)),
    ).toEqual([
      { action: "read", source: "claude_read_tool" },
      { action: "write", source: "claude_write_tool" },
    ]);
  });

  it("summarizes unrecorded legacy rows as compatibility fallback", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "context_tree_usage",
      payload: {
        purpose: "design_decision",
        treeRepoUrl: null,
        nodePath: "NODE.md",
      },
    });
    const mismatch = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "context_tree_usage",
      payload: {
        purpose: "design_decision",
        treeRepoUrl: "https://github.com/acme/not-first-tree-context.git",
        nodePath: "wrong/NODE.md",
      },
    });
    const invalidPath = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "context_tree_usage",
      payload: {
        purpose: "design_decision",
        treeRepoUrl: TREE_REPO,
        nodePath: "../escape.md",
      },
    });

    const summary = await summarizeContextTreeIo(app.db, seed.organizationId, 7);
    expect(summary.summary.read.eventCount).toBe(1);
    expect(summary.recentEvents[0]).toMatchObject({
      action: "read",
      source: "legacy_context_tree_usage",
      targetPath: "NODE.md",
    });

    const rejectedRows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, mismatch.id));
    expect(rejectedRows).toHaveLength(0);
    const invalidPathRows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, invalidPath.id));
    expect(invalidPathRows).toHaveLength(0);
  });

  it("derives shell command read IO for Codex command and Claude Bash", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const codexRead = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-codex-shell",
        name: "command",
        args: { command: "sed -n '1,120p' /tmp/context-tree/NODE.md" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
        ],
      },
    });
    const claudeRead = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-claude-shell",
        name: "Bash",
        args: { command: "cat /tmp/context-tree/practices/NODE.md" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "practices/NODE.md",
            pathKind: "file",
          },
        ],
      },
    });

    for (const item of [
      { runtimeProvider: "codex", sessionEvent: codexRead },
      { runtimeProvider: "claude-code", sessionEvent: claudeRead },
    ]) {
      await recordFromSessionEvent(app.db, {
        organizationId: seed.organizationId,
        agentId: seed.agent.uuid,
        chatId: seed.chatId,
        runtimeProvider: item.runtimeProvider,
        sessionEvent: item.sessionEvent,
      });
    }

    const rows = await app.db.select().from(contextTreeIoEvents).where(eq(contextTreeIoEvents.chatId, seed.chatId));
    expect(rows).toHaveLength(2);
    expect(
      rows
        .map((row) => ({
          runtimeProvider: row.runtimeProvider,
          action: row.action,
          source: row.source,
          targetPath: row.targetPath,
        }))
        .sort((a, b) => a.runtimeProvider.localeCompare(b.runtimeProvider)),
    ).toEqual([
      {
        runtimeProvider: "claude-code",
        action: "read",
        source: "shell_command",
        targetPath: "practices/NODE.md",
      },
      {
        runtimeProvider: "codex",
        action: "read",
        source: "shell_command",
        targetPath: "NODE.md",
      },
    ]);
  });

  it("keeps shell write commands unsupported and explains common skip reasons", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const shellWrite = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-shell-write",
        name: "command",
        args: { command: "echo x > /tmp/context-tree/NODE.md" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
        ],
      },
    });

    await recordFromSessionEvent(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      runtimeProvider: "codex",
      sessionEvent: shellWrite,
    });

    const rows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, shellWrite.id));
    expect(rows).toHaveLength(0);
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: shellWrite,
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_shell_command" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-no-refs",
            name: "command",
            args: { command: "cat /tmp/context-tree/NODE.md" },
            status: "ok",
          },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "no_tool_file_refs" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-repo-mismatch",
            name: "command",
            args: { command: "cat /tmp/context-tree/NODE.md" },
            status: "ok",
            toolFileRefs: [
              {
                origin: "tool_arg",
                repoUrl: "https://github.com/acme/other.git",
                repoBranch: "main",
                repoRelativePath: "NODE.md",
                pathKind: "file",
              },
            ],
          },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "ref_repo_mismatch" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-find-delete",
            name: "command",
            args: { command: "find /tmp/context-tree -delete" },
            status: "ok",
            toolFileRefs: [
              {
                origin: "tool_arg",
                repoUrl: TREE_REPO,
                repoBranch: "main",
                repoRelativePath: "/",
                pathKind: "repo",
              },
            ],
          },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_shell_command" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-comment",
            name: "command",
            args: { command: "cat NODE.md # members/alice/NODE.md" },
            status: "ok",
            toolFileRefs: [
              {
                origin: "tool_arg",
                repoUrl: TREE_REPO,
                repoBranch: "main",
                repoRelativePath: "members/alice/NODE.md",
                pathKind: "file",
              },
            ],
          },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_shell_command" });
  });

  it("derives Claude search and notebook IO at the granularity the refs carry", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const grep = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-grep",
        name: "Grep",
        args: { pattern: "owners", path: "/tmp/context-tree/members" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "members",
            pathKind: "directory",
          },
        ],
      },
    });
    const glob = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-glob",
        name: "Glob",
        args: { pattern: "**/*.md", path: "/tmp/context-tree" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "/",
            pathKind: "repo",
          },
        ],
      },
    });
    const notebookEdit = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-notebook-edit",
        name: "NotebookEdit",
        args: { notebook_path: "/tmp/context-tree/designs/spike.ipynb" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "designs/spike.ipynb",
            pathKind: "file",
          },
        ],
      },
    });

    for (const sessionEvent of [grep, glob, notebookEdit]) {
      await recordFromSessionEvent(app.db, {
        organizationId: seed.organizationId,
        agentId: seed.agent.uuid,
        chatId: seed.chatId,
        runtimeProvider: "claude-code",
        sessionEvent,
      });
    }

    const grepRows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, grep.id));
    expect(grepRows).toHaveLength(1);
    expect(grepRows[0]).toMatchObject({
      action: "read",
      source: "claude_read_tool",
      targetKind: "directory",
      targetPath: "members",
    });

    const globRows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, glob.id));
    expect(globRows[0]).toMatchObject({ action: "read", targetKind: "repo", targetPath: "/" });

    const notebookRows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, notebookEdit.id));
    expect(notebookRows[0]).toMatchObject({
      action: "write",
      source: "claude_write_tool",
      targetPath: "designs/spike.ipynb",
    });

    // A search call whose client attached no refs (no explicit path argument)
    // stays unrecordable — fail-safe under-counting, not cwd guessing.
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: {
          kind: "tool_call",
          payload: { toolUseId: "tu-grep-norefs", name: "Grep", args: { pattern: "owners" }, status: "ok" },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "no_tool_file_refs" });
  });

  it("summarizes skipped context-tree IO candidates by reason", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "assistant_text",
      payload: { text: "not a tool call" },
    });
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-shell-write",
        name: "Bash",
        args: { command: "echo x > /tmp/context-tree/NODE.md" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
        ],
      },
    });
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-no-refs",
        name: "Bash",
        args: { command: "cat /tmp/context-tree/NODE.md" },
        status: "ok",
      },
    });
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-repo-mismatch",
        name: "Read",
        args: {},
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: "https://github.com/acme/other.git",
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
        ],
      },
    });
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-valid",
        name: "Read",
        args: {},
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
        ],
      },
    });

    const skipped = await summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7);

    expect(skipped.totalEventCount).toBe(3);
    expect(skipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toEqual([
      { reason: "no_tool_file_refs", eventCount: 1 },
      { reason: "ref_repo_mismatch", eventCount: 1 },
      { reason: "unsupported_shell_command", eventCount: 1 },
    ]);
    expect(skipped.reasons.find((row) => row.reason === "unsupported_shell_command")).toMatchObject({
      agentCount: 1,
      runtimeProviders: [{ runtimeProvider: "claude-code", eventCount: 1 }],
      toolNames: [{ toolName: "Bash", eventCount: 1 }],
    });

    const io = await summarizeContextTreeIo(app.db, seed.organizationId, 7);
    expect(io.skipped).toEqual(skipped);
  });
});
