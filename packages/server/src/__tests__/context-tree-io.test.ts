import type { ContextTreeWriteEvent } from "@first-tree/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/connection.js";
import { agents } from "../db/schema/agents.js";
import { chatMembership } from "../db/schema/chat-membership.js";
import { chats } from "../db/schema/chats.js";
import { contextTreeIoEvents } from "../db/schema/context-tree-io-events.js";
import { organizations } from "../db/schema/organizations.js";
import { sessionEvents } from "../db/schema/session-events.js";
import {
  buildContextTreeIoSummary,
  explainContextTreeIoDecision,
  reconcileContextTreeWrites,
  recordFromSessionEvent,
  summarizeContextTreeIo,
  summarizeContextTreeIoSkippedEvents,
} from "../services/context-tree-io.js";
import { putOrgSetting } from "../services/org-settings.js";
import { appendEvent } from "../services/session-event.js";
import { createTestAgent, useTestApp } from "./helpers.js";

const TREE_REPO = "https://github.com/acme/first-tree-context.git";
const TREE_REPO_SSH = "git@github.com:acme/first-tree-context.git";
const ALT_TREE_REPO = "https://github.com/acme/alternate-context.git";

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

  it("derives cursor read/edit/write IO from tool names, gated on runtimeProvider=cursor", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const mkEvent = (toolUseId: string, name: string, path: string, origin: "tool_arg" | "file_change") => ({
      kind: "tool_call" as const,
      payload: {
        toolUseId,
        name,
        args: { path: `/tmp/context-tree/${path}` },
        status: "ok" as const,
        toolFileRefs: [
          { origin, repoUrl: TREE_REPO, repoBranch: "main", repoRelativePath: path, pathKind: "file" as const },
        ],
      },
    });

    const readEvent = await appendEvent(
      app.db,
      seed.agent.uuid,
      seed.chatId,
      mkEvent("tu-c-read", "read", "NODE.md", "tool_arg"),
    );
    const editEvent = await appendEvent(
      app.db,
      seed.agent.uuid,
      seed.chatId,
      mkEvent("tu-c-edit", "edit", "system/NODE.md", "file_change"),
    );
    const writeEvent = await appendEvent(
      app.db,
      seed.agent.uuid,
      seed.chatId,
      mkEvent("tu-c-write", "write", "practices/new.md", "file_change"),
    );

    for (const sessionEvent of [readEvent, editEvent, writeEvent]) {
      await recordFromSessionEvent(app.db, {
        organizationId: seed.organizationId,
        agentId: seed.agent.uuid,
        chatId: seed.chatId,
        runtimeProvider: "cursor",
        sessionEvent,
      });
    }

    const rows = await app.db.select().from(contextTreeIoEvents).where(eq(contextTreeIoEvents.chatId, seed.chatId));
    expect(
      rows
        .map((row) => ({ action: row.action, source: row.source, targetPath: row.targetPath }))
        .sort((a, b) => a.targetPath.localeCompare(b.targetPath)),
    ).toEqual([
      { action: "read", source: "cursor_read_tool", targetPath: "NODE.md" },
      { action: "write", source: "cursor_write_tool", targetPath: "practices/new.md" },
      { action: "write", source: "cursor_write_tool", targetPath: "system/NODE.md" },
    ]);

    // Provider gating both ways: cursor's lowercase names mean nothing to
    // other providers, and codex's `command` means nothing to cursor.
    expect(
      explainContextTreeIoDecision({ runtimeProvider: "codex", sessionEvent: readEvent, bindingRepo: TREE_REPO }),
    ).toEqual({ recordable: false, reason: "unsupported_tool" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "cursor",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-x",
            name: "command",
            args: { command: "cat /tmp/context-tree/NODE.md" },
            status: "ok",
          },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_tool" });
  });

  it("end-to-end regression: a real-shaped completed cursor shell event lands as a repo-qualified read", async () => {
    // The exact event shape the cursor handler emits after client enrichment
    // for a tree read via shell (`cat <tree>/NODE.md`) — the path the old
    // prototype's final review found missing. Must be recorded server-side.
    const app = getApp();
    const seed = await seedContextTreeChat();

    const shellEvent = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tool_b4d948d0-f5c0-4367-a482-3eed23696d4",
        name: "shell",
        args: { command: "cat context-tree/NODE.md", cwd: "/home/op/.first-tree/workspaces/agent-1" },
        status: "ok",
        resultPreview: "# Context Tree Root",
        toolFileRefs: [
          {
            origin: "tool_arg",
            localPath: "context-tree/NODE.md",
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
      runtimeProvider: "cursor",
      sessionEvent: shellEvent,
    });

    const rows = await app.db.select().from(contextTreeIoEvents).where(eq(contextTreeIoEvents.chatId, seed.chatId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runtimeProvider: "cursor",
      action: "read",
      source: "shell_command",
      treeRepoUrl: TREE_REPO,
      targetPath: "NODE.md",
    });
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
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "custom-runtime",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-unsupported-tool",
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
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_tool" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-recordable",
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
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: true });
  });

  it("explains IO decision edge cases for paths, bindings, statuses, and shell args", () => {
    const readEvent = (repoRelativePath: unknown, extra: Record<string, unknown> = {}) => ({
      kind: "tool_call",
      payload: {
        toolUseId: `tu-${crypto.randomUUID()}`,
        name: "Read",
        args: {},
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: TREE_REPO,
            repoRelativePath,
            ...extra,
          },
        ],
      },
    });

    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: readEvent("NODE.md"),
        bindingRepo: null,
      }),
    ).toEqual({ recordable: false, reason: "no_org_context_tree_binding" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: { kind: "tool_call", payload: { name: "Read", status: "ok" } },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "event_kind_not_io" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: {
          kind: "tool_call",
          payload: { toolUseId: "tu-status", name: "Read", args: {}, status: "error" },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "status_not_ok" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: {
          kind: "tool_call",
          payload: { toolUseId: "tu-kind", name: "Read", args: {}, status: "ok", toolFileRefs: [] },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "no_tool_file_refs" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: { toolUseId: "tu-shell-no-args", name: "command", args: null, status: "ok" },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_shell_command" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: {
          kind: "tool_call",
          payload: { toolUseId: "tu-shell-non-string", name: "command", args: { command: 1 }, status: "ok" },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "unsupported_shell_command" });

    for (const repoRelativePath of ["/absolute.md", ".", "..", "../escape.md"]) {
      expect(
        explainContextTreeIoDecision({
          runtimeProvider: "claude-code",
          sessionEvent: readEvent(repoRelativePath),
          bindingRepo: TREE_REPO,
        }),
      ).toEqual({ recordable: false, reason: "ref_path_invalid" });
    }
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: readEvent(""),
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "event_kind_not_io" });
    for (const repoRelativePath of ["   ", "members/\0alice.md"]) {
      expect(
        explainContextTreeIoDecision({
          runtimeProvider: "claude-code",
          sessionEvent: readEvent(repoRelativePath),
          bindingRepo: TREE_REPO,
        }),
      ).toEqual({ recordable: false, reason: "ref_path_invalid" });
    }
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: readEvent(123),
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "event_kind_not_io" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "codex",
        sessionEvent: { kind: "assistant_text", payload: { text: "not IO" } },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: false, reason: "event_kind_not_io" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "custom-runtime",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-mixed-git-delta",
            name: "UnknownTool",
            args: {},
            status: "ok",
            toolFileRefs: [
              {
                origin: "tool_arg",
                repoUrl: TREE_REPO,
                repoRelativePath: "ignored.md",
              },
              {
                origin: "git_status_delta",
                repoUrl: TREE_REPO,
                repoRelativePath: "NODE.md",
              },
            ],
          },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: true });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: readEvent("/", { pathKind: "repo" }),
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: true });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: readEvent(".", { pathKind: "repo" }),
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: true });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: readEvent("NODE.md"),
        bindingRepo: TREE_REPO,
        chatInOrg: false,
      }),
    ).toEqual({ recordable: false, reason: "chat_not_in_org" });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: readEvent("NODE.md", { repoBranch: undefined, metadata: { toolName: "Read" } }),
        bindingRepo: TREE_REPO,
        bindingBranch: "develop",
      }),
    ).toEqual({ recordable: true });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "claude-code",
        sessionEvent: {
          kind: "context_tree_usage",
          payload: { purpose: "design_decision", treeRepoUrl: TREE_REPO, nodePath: null },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: true });
    expect(
      explainContextTreeIoDecision({
        runtimeProvider: "custom-runtime",
        sessionEvent: {
          kind: "tool_call",
          payload: {
            toolUseId: "tu-git-delta",
            name: "UnknownTool",
            args: {},
            status: "ok",
            toolFileRefs: [
              {
                origin: "git_status_delta",
                repoUrl: TREE_REPO,
                repoRelativePath: "NODE.md",
              },
            ],
          },
        },
        bindingRepo: TREE_REPO,
      }),
    ).toEqual({ recordable: true });
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

  it("skips diagnostics scan for already-recorded IO events", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: Array<{ name: string; fields?: Record<string, unknown> }> = [];

    const recorded = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-recorded",
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
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-skipped",
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
    await recordFromSessionEvent(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      runtimeProvider: "claude-code",
      sessionEvent: recorded,
    });

    const skipped = await summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7, {
      timing: (name, _ms, fields) => timings.push({ name, fields }),
    });

    expect(skipped.totalEventCount).toBe(1);
    expect(timings.find((timing) => timing.name === "io_skipped_rows")?.fields).toMatchObject({ rowCount: 1 });
  });

  it("prefilters skipped diagnostics by organization agents before scanning session events", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: Array<{ name: string; fields?: Record<string, unknown> }> = [];

    await summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7, {
      timing: (name, _ms, fields) => timings.push({ name, fields }),
    });

    const agentRows = timings.find((timing) => timing.name === "io_skipped_agents_rows")?.fields;
    expect(agentRows).toBeDefined();
    expect(Number(agentRows?.agentCount)).toBeGreaterThanOrEqual(1);
  });

  it("filters unrelated tool calls out of skipped diagnostics candidates", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: Array<{ name: string; fields?: Record<string, unknown> }> = [];

    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-unrelated",
        name: "TodoWrite",
        args: {},
        status: "ok",
      },
    });
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-candidate",
        name: "Bash",
        args: { command: "cat /tmp/context-tree/NODE.md" },
        status: "ok",
      },
    });

    const skipped = await summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7, {
      timing: (name, _ms, fields) => timings.push({ name, fields }),
    });

    expect(skipped.totalEventCount).toBe(1);
    expect(skipped.reasons).toEqual([
      {
        reason: "no_tool_file_refs",
        eventCount: 1,
        agentCount: 1,
        runtimeProviders: [{ runtimeProvider: "claude-code", eventCount: 1 }],
        toolNames: [{ toolName: "Bash", eventCount: 1 }],
      },
    ]);
    expect(timings.find((timing) => timing.name === "io_skipped_rows")?.fields).toMatchObject({ rowCount: 1 });
  });

  it("fast-paths skipped diagnostics decisions for no-ref candidates", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: Array<{ name: string; fields?: Record<string, unknown> }> = [];

    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-read-no-refs",
        name: "Read",
        args: {},
        status: "ok",
      },
    });
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-shell-read-no-refs",
        name: "Bash",
        args: { command: "cat /tmp/context-tree/NODE.md" },
        status: "ok",
      },
    });
    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-shell-write-no-refs",
        name: "Bash",
        args: { command: "echo x > /tmp/context-tree/NODE.md" },
        status: "ok",
      },
    });

    const skipped = await summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7, {
      timing: (name, _ms, fields) => timings.push({ name, fields }),
    });

    expect(skipped.totalEventCount).toBe(3);
    expect(skipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toEqual([
      { reason: "no_tool_file_refs", eventCount: 2 },
      { reason: "unsupported_shell_command", eventCount: 1 },
    ]);
    expect(timings.find((timing) => timing.name === "io_skipped_decide_fast_rows")?.fields).toMatchObject({
      rowCount: 3,
    });
    expect(timings.find((timing) => timing.name === "io_skipped_decide_slow_rows")?.fields).toMatchObject({
      rowCount: 0,
    });
  });

  it("fast-paths codex file-change and custom-runtime no-ref skip diagnostics", async () => {
    const app = getApp();
    const codexSeed = await seedContextTreeChat();
    await app.db.update(agents).set({ runtimeProvider: "codex" }).where(eq(agents.uuid, codexSeed.agent.uuid));
    await appendEvent(app.db, codexSeed.agent.uuid, codexSeed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-codex-file-change-no-refs",
        name: "file_change",
        args: {},
        status: "ok",
      },
    });

    const codexSkipped = await summarizeContextTreeIoSkippedEvents(app.db, codexSeed.organizationId, 7);
    expect(codexSkipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toEqual([
      { reason: "no_tool_file_refs", eventCount: 1 },
    ]);

    const customSeed = await seedContextTreeChat();
    await app.db
      .update(agents)
      .set({ runtimeProvider: "custom-runtime" })
      .where(eq(agents.uuid, customSeed.agent.uuid));
    await appendEvent(app.db, customSeed.agent.uuid, customSeed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-custom-read-no-refs",
        name: "Read",
        args: {},
        status: "ok",
      },
    });

    const customSkipped = await summarizeContextTreeIoSkippedEvents(app.db, customSeed.organizationId, 7);
    expect(customSkipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toContainEqual({
      reason: "unsupported_tool",
      eventCount: 1,
    });
  });

  it("keeps no-binding skipped diagnostics off the no-ref fast path", async () => {
    const app = getApp();
    const seed = await createTestAgent(app);
    const chatId = `chat-${crypto.randomUUID()}`;
    const timings: Array<{ name: string; fields?: Record<string, unknown> }> = [];
    await app.db.insert(chats).values({ id: chatId, organizationId: seed.organizationId, type: "direct", topic: "io" });
    await appendEvent(app.db, seed.agent.uuid, chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-read-no-binding",
        name: "Read",
        args: {},
        status: "ok",
      },
    });

    const skipped = await summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7, {
      timing: (name, _ms, fields) => timings.push({ name, fields }),
    });

    expect(skipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toEqual([
      { reason: "no_org_context_tree_binding", eventCount: 1 },
    ]);
    expect(timings.find((timing) => timing.name === "io_skipped_decide_fast_rows")?.fields).toMatchObject({
      rowCount: 0,
    });
    expect(timings.find((timing) => timing.name === "io_skipped_decide_slow_rows")?.fields).toMatchObject({
      rowCount: 1,
    });
  });

  it("classifies malformed skipped-diagnostics candidate payloads through the slow path", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: Array<{ name: string; fields?: Record<string, unknown> }> = [];

    await app.db.insert(sessionEvents).values({
      id: `ev-${crypto.randomUUID()}`,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      seq: 1,
      kind: "tool_call",
      payload: {
        name: "Bash",
        args: { command: "cat /tmp/context-tree/NODE.md" },
        status: "ok",
      },
      createdAt: new Date(),
    });

    const skipped = await summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7, {
      timing: (name, _ms, fields) => timings.push({ name, fields }),
    });

    expect(skipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toEqual([
      { reason: "event_kind_not_io", eventCount: 1 },
    ]);
    expect(timings.find((timing) => timing.name === "io_skipped_decide_fast_rows")?.fields).toMatchObject({
      rowCount: 0,
    });
    expect(timings.find((timing) => timing.name === "io_skipped_decide_slow_rows")?.fields).toMatchObject({
      rowCount: 1,
    });
  });

  it("classifies fake skipped-diagnostics rows that are awkward to produce through SQL", async () => {
    const selectResults = [
      [{ agentId: "agent-known", runtimeProvider: "codex" }],
      [
        {
          id: "ev-array-payload",
          agentId: "agent-known",
          chatId: "chat-1",
          kind: "tool_call",
          payload: [],
          chatOrganizationId: "org-1",
        },
        {
          id: "ev-status-error",
          agentId: "agent-known",
          chatId: "chat-1",
          kind: "tool_call",
          payload: { toolUseId: "tu-error", name: "command", args: {}, status: "error" },
          chatOrganizationId: "org-1",
        },
        {
          id: "ev-missing-agent",
          agentId: "agent-missing",
          chatId: "chat-1",
          kind: "tool_call",
          payload: { toolUseId: "tu-no-refs", name: "command", args: { command: "cat NODE.md" }, status: "ok" },
          chatOrganizationId: "org-1",
        },
        {
          id: "ev-bad-refs",
          agentId: "agent-known",
          chatId: "chat-1",
          kind: "tool_call",
          payload: { toolUseId: "tu-bad-refs", name: "command", args: {}, status: "ok", toolFileRefs: "bad" },
          chatOrganizationId: "org-1",
        },
      ],
    ];
    const db = {
      select: vi.fn(() => {
        const result = selectResults.shift() ?? [];
        const builder = {
          from: vi.fn(() => builder),
          leftJoin: vi.fn(() => builder),
          where: vi.fn(async () => result),
        };
        return builder;
      }),
    } as unknown as Database;

    const skipped = await summarizeContextTreeIoSkippedEvents(db, "org-1", 7, {
      contextTreeBinding: { repo: TREE_REPO },
    });

    expect(skipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toEqual([
      { reason: "event_kind_not_io", eventCount: 2 },
      { reason: "status_not_ok", eventCount: 1 },
      { reason: "unsupported_tool", eventCount: 1 },
    ]);
    expect(skipped.reasons.find((row) => row.reason === "unsupported_tool")?.runtimeProviders).toEqual([
      { runtimeProvider: "unknown", eventCount: 1 },
    ]);
  });

  it("ignores malformed toolFileRefs while filtering skipped diagnostics candidates", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    await app.db.insert(sessionEvents).values({
      id: `ev-${crypto.randomUUID()}`,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      seq: 1,
      kind: "tool_call",
      payload: {
        toolUseId: "tu-malformed-refs",
        name: "TodoWrite",
        args: {},
        status: "ok",
        toolFileRefs: { repoUrl: TREE_REPO, repoRelativePath: "NODE.md" },
      },
      createdAt: new Date(),
    });

    await expect(summarizeContextTreeIoSkippedEvents(app.db, seed.organizationId, 7)).resolves.toEqual({
      windowDays: 7,
      totalEventCount: 0,
      reasons: [],
    });
  });

  it("returns empty IO summaries when an organization has no candidate agents", async () => {
    const app = getApp();
    const organizationId = crypto.randomUUID();
    const timings: Array<{ name: string; fields?: Record<string, unknown> }> = [];
    await app.db.insert(organizations).values({
      id: organizationId,
      name: `empty-${crypto.randomUUID().slice(0, 8)}`,
      displayName: "Empty Org",
    });

    const summary = await summarizeContextTreeIo(app.db, organizationId, 7, undefined, {
      timing: (name, _ms, fields) => timings.push({ name, fields }),
    });

    expect(summary.summary).toEqual({
      read: { agentCount: 0, eventCount: 0, targetCount: 0 },
      write: { agentCount: 0, eventCount: 0, targetCount: 0 },
    });
    expect(summary.skipped).toEqual({ windowDays: 7, totalEventCount: 0, reasons: [] });
    expect(timings.find((timing) => timing.name === "io_backfill_rows")?.fields).toMatchObject({ rowCount: 0 });
    expect(timings.find((timing) => timing.name === "io_skipped_rows")?.fields).toMatchObject({ rowCount: 0 });
  });

  it("maps summary fallback rows from a fake database", async () => {
    const executeResults = [
      [
        { action: "read", agent_count: "2", event_count: null, target_count: undefined },
        { action: "other", agent_count: 99, event_count: 99, target_count: 99 },
      ],
      [
        {
          agent_id: "agent-1",
          agent_name: "Agent One",
          agent_avatar_color_token: null,
          runtime_provider: "codex",
          read_count: "3",
          write_count: undefined,
          last_read_at: null,
          last_write_at: "2026-01-02T00:00:00.000Z",
          last_event_at: "2026-01-02T00:00:00.000Z",
        },
      ],
      [
        {
          id: "io-1",
          agent_id: "agent-1",
          agent_name: "Agent One",
          agent_avatar_color_token: null,
          runtime_provider: "codex",
          action: "unexpected",
          source: "shell_command",
          target_kind: "unknown",
          target_path: "NODE.md",
          raw_chat_id: "chat-outside",
          joined_chat_id: null,
          chat_topic: null,
          created_at: null,
        },
      ],
    ];
    const db = {
      execute: vi.fn(async () => executeResults.shift() ?? []),
      select: vi.fn(() => {
        const builder = {
          from: vi.fn(() => builder),
          where: vi.fn(async () => []),
        };
        return builder;
      }),
    } as unknown as Database;

    const summary = await summarizeContextTreeIo(db, "org-1", 7, undefined, {
      backfillSessionEvents: false,
      contextTreeBinding: { repo: TREE_REPO },
    });

    expect(summary.summary).toEqual({
      read: { agentCount: 2, eventCount: 0, targetCount: 0 },
      write: { agentCount: 0, eventCount: 0, targetCount: 0 },
    });
    expect(summary.agents[0]).toMatchObject({ readCount: 3, writeCount: 0, lastReadAt: null });
    expect(summary.recentEvents[0]).toMatchObject({
      action: "read",
      targetKind: "file",
      chatId: null,
      chatTitle: null,
      viewerCanAccess: false,
    });
  });

  it("skips recordable IO events when the chat no longer belongs to the organization", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const persisted = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-orphan-chat",
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

    await recordFromSessionEvent(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: `missing-${crypto.randomUUID()}`,
      runtimeProvider: "claude-code",
      sessionEvent: persisted,
    });

    const rows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, persisted.id));
    expect(rows).toHaveLength(0);
  });

  it("marks context-tree read feed access through direct and supervised chat memberships", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    await app.db.insert(chatMembership).values([
      { chatId: seed.chatId, agentId: seed.humanAgentUuid, accessMode: "watcher" },
      { chatId: seed.chatId, agentId: seed.agent.uuid, accessMode: "speaker" },
    ]);
    const persisted = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "context_tree_usage",
      payload: {
        purpose: "design_decision",
        treeRepoUrl: TREE_REPO,
        nodePath: "domains/runtime/NODE.md",
      },
    });
    await recordFromSessionEvent(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      runtimeProvider: "claude-code",
      sessionEvent: persisted,
    });

    const summary = await summarizeContextTreeIo(app.db, seed.organizationId, 7, {
      humanAgentId: seed.humanAgentUuid,
      memberId: seed.memberId,
    });

    expect(summary.recentEvents[0]).toMatchObject({
      chatId: seed.chatId,
      chatTitle: "io",
      viewerCanAccess: true,
    });
  });

  it("records git status delta refs as synthetic writes for unsupported shell commands", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    const shellWrite = await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-shell-write",
        name: "Bash",
        args: { command: "cat <<'EOF' > context-tree/NODE.md\nupdated\nEOF" },
        status: "ok",
        toolFileRefs: [
          {
            origin: "git_status_delta",
            localPath: "/context-tree/NODE.md",
            repoUrl: TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
            metadata: {
              origin: "spoofed_origin",
              localPath: "/spoofed/NODE.md",
              toolName: "Bash",
              toolUseId: "tu-shell-write",
              gitStatus: " M",
            },
          },
        ],
      },
    });

    await recordFromSessionEvent(app.db, {
      organizationId: seed.organizationId,
      agentId: seed.agent.uuid,
      chatId: seed.chatId,
      runtimeProvider: "claude-code",
      sessionEvent: shellWrite,
    });

    const rows = await app.db
      .select()
      .from(contextTreeIoEvents)
      .where(eq(contextTreeIoEvents.sourceSessionEventId, shellWrite.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "write",
      source: "git_status_delta",
      targetKind: "file",
      targetPath: "NODE.md",
      metadata: {
        origin: "git_status_delta",
        localPath: "/context-tree/NODE.md",
        toolName: "Bash",
        toolUseId: "tu-shell-write",
        gitStatus: " M",
      },
    });

    const summary = await summarizeContextTreeIo(app.db, seed.organizationId, 7);
    // recentEvents is reads-only now: writes are git-derived and reconciled by
    // the route, so the telemetry write must NOT appear in the reads feed. It is
    // still recorded (asserted above) and still counts toward the write summary
    // bucket, where reconcileContextTreeWrites reads it for agent attribution.
    expect(summary.recentEvents.some((event) => event.source === "git_status_delta")).toBe(false);
    expect(summary.recentEvents.every((event) => event.action === "read")).toBe(true);
    expect(summary.summary.write.eventCount).toBeGreaterThanOrEqual(1);
  });

  it("builds full IO summary with a single session-event backfill pass", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: string[] = [];

    const summary = await buildContextTreeIoSummary(app.db, seed.organizationId, 7, [], undefined, {
      timing: (name) => timings.push(name),
    });

    expect(summary.writes).toEqual([]);
    expect(timings.filter((name) => name === "io_backfill_scan")).toHaveLength(1);
  });

  it("includes skipped diagnostics in the snapshot aggregate path", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: string[] = [];

    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-skipped",
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

    const summary = await buildContextTreeIoSummary(app.db, seed.organizationId, 7, [], undefined, {
      timing: (name) => timings.push(name),
    });

    expect(summary.skipped.totalEventCount).toBe(1);
    expect(summary.skipped.reasons.map((row) => ({ reason: row.reason, eventCount: row.eventCount }))).toEqual([
      { reason: "unsupported_shell_command", eventCount: 1 },
    ]);
    expect(timings).toContain("io_skipped_scan");
  });

  it("reuses snapshot binding for skipped diagnostics in the aggregate path", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();
    const timings: string[] = [];

    await appendEvent(app.db, seed.agent.uuid, seed.chatId, {
      kind: "tool_call",
      payload: {
        toolUseId: "tu-reused-binding",
        name: "Read",
        args: {},
        status: "ok",
        toolFileRefs: [
          {
            origin: "tool_arg",
            repoUrl: ALT_TREE_REPO,
            repoBranch: "main",
            repoRelativePath: "NODE.md",
            pathKind: "file",
          },
        ],
      },
    });

    const summary = await buildContextTreeIoSummary(app.db, seed.organizationId, 7, [], undefined, {
      contextTreeBinding: { repo: ALT_TREE_REPO, branch: "main" },
      timing: (name) => timings.push(name),
    });

    expect(summary.skipped.totalEventCount).toBe(0);
    expect(timings).toContain("io_skipped_scan");
    expect(timings).not.toContain("io_skipped_binding");
  });

  it("reconciles git writes with telemetry: attributes the agent, keeps unmatched git authors, surfaces telemetry-only writes", async () => {
    const app = getApp();
    const seed = await seedContextTreeChat();

    // Timestamps are relative to now so the test does not age out of the
    // reconcile window (writes filter from `Date.now() - windowDays`).
    const now = Date.now();
    const minutesAgo = (mins: number): Date => new Date(now - mins * 60_000);
    const isoMinutesAgo = (mins: number): string => minutesAgo(mins).toISOString();

    async function seedWriteTelemetry(targetPath: string, mins: number): Promise<void> {
      await app.db.insert(contextTreeIoEvents).values({
        id: `cte-${crypto.randomUUID()}`,
        organizationId: seed.organizationId,
        agentId: seed.agent.uuid,
        chatId: seed.chatId,
        sourceSessionEventId: `ev-${crypto.randomUUID()}`,
        runtimeProvider: "claude-code",
        action: "write",
        source: "claude_write_tool",
        treeRepoUrl: TREE_REPO,
        treeBranch: "main",
        targetKind: "file",
        targetPath,
        createdAt: minutesAgo(mins),
      });
    }

    // system/x: edited in a worktree (telemetry, 60m ago) then landed as PR #514
    // (git, 50m ago) → reconcile to ONE attributed row.
    await seedWriteTelemetry("system/x.md", 60);
    // members/y: in-flight worktree edit with no landed commit → telemetry-only.
    await seedWriteTelemetry("members/y/NODE.md", 70);
    // Root NODE.md edit (telemetry path "NODE.md" must reconcile with the git
    // root write whose node path is "").
    await seedWriteTelemetry("NODE.md", 80);
    // system/late: a NEW in-flight edit (30m ago) on a node whose only git
    // commit is OLDER (120m ago). The later telemetry must NOT be attached to
    // the old commit, and must surface as its own in-flight row.
    await seedWriteTelemetry("system/late.md", 30);

    const base = {
      nodeId: null,
      title: "",
      summary: null,
      riskLevel: "low" as const,
      agentId: null,
      agentName: null,
      agentAvatarColorToken: null,
    };
    const gitWrites: ContextTreeWriteEvent[] = [
      {
        ...base,
        id: "c1",
        nodePath: "system/x",
        changeType: "edited",
        authorName: "a-committer",
        commit: "a".repeat(40),
        prNumber: 514,
        createdAt: isoMinutesAgo(50),
      },
      // PR-merge commit telemetry never saw → honest git author.
      {
        ...base,
        id: "c2",
        nodePath: "system/merged",
        changeType: "edited",
        authorName: "GitHub",
        commit: "b".repeat(40),
        prNumber: 702,
        createdAt: isoMinutesAgo(40),
      },
      // Root write; git node path is "" (must match telemetry "NODE.md").
      {
        ...base,
        id: "c3",
        nodePath: "",
        changeType: "edited",
        authorName: "root-committer",
        commit: "c".repeat(40),
        prNumber: 800,
        createdAt: isoMinutesAgo(70),
      },
      // Old commit whose only telemetry edit happens AFTER it (finding R4).
      {
        ...base,
        id: "c4",
        nodePath: "system/late",
        changeType: "edited",
        authorName: "merge-bot",
        commit: "d".repeat(40),
        prNumber: 900,
        createdAt: isoMinutesAgo(120),
      },
    ];

    const writes = await reconcileContextTreeWrites(app.db, seed.organizationId, 7, gitWrites);

    // system/x: reconciled to the authoring agent; PR preserved; ONE row.
    const xRows = writes.filter((w) => w.nodePath === "system/x");
    expect(xRows).toHaveLength(1);
    expect(xRows[0]).toMatchObject({ agentId: seed.agent.uuid, prNumber: 514, commit: "a".repeat(40) });

    // system/merged: no telemetry → honest git author, null agent.
    expect(writes.find((w) => w.nodePath === "system/merged")).toMatchObject({
      agentId: null,
      authorName: "GitHub",
      prNumber: 702,
    });

    // members/y: telemetry-only in-flight write, attributed, no commit/PR.
    expect(writes.find((w) => w.nodePath === "members/y")).toMatchObject({
      agentId: seed.agent.uuid,
      commit: null,
      prNumber: null,
    });

    // Root: telemetry "NODE.md" reconciles with the git root write (path "") →
    // exactly one root row, attributed, PR preserved.
    const rootRows = writes.filter((w) => w.nodePath === "");
    expect(rootRows).toHaveLength(1);
    expect(rootRows[0]).toMatchObject({ agentId: seed.agent.uuid, prNumber: 800 });

    // system/late: the old commit keeps its git author (no telemetry preceded
    // it), and the later in-flight edit surfaces as its own attributed row.
    const lateRows = writes.filter((w) => w.nodePath === "system/late");
    expect(lateRows).toHaveLength(2);
    expect(lateRows.find((w) => w.commit !== null)).toMatchObject({
      agentId: null,
      authorName: "merge-bot",
      prNumber: 900,
    });
    expect(lateRows.find((w) => w.commit === null)).toMatchObject({ agentId: seed.agent.uuid, prNumber: null });

    // Sorted newest-first by time.
    const times = writes.map((w) => (w.createdAt ? Date.parse(w.createdAt) : 0));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it("reconciles write telemetry with null, invalid, and root-ish timestamps", async () => {
    const db = {
      execute: vi.fn(async () => [
        {
          agent_id: "agent-1",
          agent_name: "Agent One",
          agent_avatar_color_token: null,
          target_path: "system/null.md",
          created_at: null,
        },
        {
          agent_id: "agent-2",
          agent_name: "Agent Two",
          agent_avatar_color_token: "blue",
          target_path: "system/bad.md",
          created_at: null,
        },
        {
          agent_id: "agent-3",
          agent_name: "Agent Three",
          agent_avatar_color_token: "green",
          target_path: "/",
          created_at: "2026-01-03T00:00:00.000Z",
        },
      ]),
    } as unknown as Database;
    const base = {
      nodeId: null,
      title: "",
      summary: null,
      riskLevel: "low" as const,
      authorName: "git-author",
      agentId: null,
      agentName: null,
      agentAvatarColorToken: null,
      commit: null,
      prNumber: null,
    };

    const writes = await reconcileContextTreeWrites(
      db,
      "org-1",
      7,
      [
        { ...base, id: "git-null", nodePath: "system/null", changeType: "edited", createdAt: null },
        { ...base, id: "git-bad", nodePath: "system/bad", changeType: "edited", createdAt: "not-a-date" },
      ],
      { backfillSessionEvents: false },
    );

    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "git-null", agentId: "agent-1" }),
        expect.objectContaining({ id: "git-bad", agentId: "agent-2" }),
        expect.objectContaining({ nodePath: "", title: "Context Tree", agentId: "agent-3" }),
      ]),
    );
  });
});
