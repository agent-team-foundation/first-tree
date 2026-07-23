import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { AUDIT_CONTEXT_TREE_VALUE_CASES, AUDIT_CONTEXT_TREE_VALUE_SUITE } from "../cases.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..", "..");
const skillRoot = join(repoRoot, "skills", "audit-context-tree-value");
const scriptPath = join(skillRoot, "scripts", "audit_context_tree_value.py");
const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const OUTSIDE_CHAT_ID = "22222222-2222-4222-8222-222222222222";
const UNAUTHORIZED_CHAT_ID = "88888888-8888-4888-8888-888888888888";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";
const AGENT_TWO_ID = "99999999-9999-4999-8999-999999999999";
const AUDIT_ID = `${CHAT_ID}@${AGENT_ID}`;
const AUDIT_TWO_ID = `${CHAT_ID}@${AGENT_TWO_ID}`;

function writeJsonl(path: string, rows: readonly unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function writeWorkspaceIdentity(workspace: string, agentId: string): void {
  const runtimeDir = join(workspace, ".first-tree-workspace");
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "identity.json"), JSON.stringify({ agentId, type: "agent" }), "utf8");
}

describe("audit-context-tree-value deterministic floor", () => {
  let runRoot: string | null = null;

  afterEach(() => {
    if (runRoot !== null) {
      rmSync(runRoot, { recursive: true, force: true });
      runRoot = null;
    }
  });

  it("keeps the trigger manual and distinct from ordinary task reads", () => {
    const skill = readFileSync(join(skillRoot, "SKILL.md"), "utf8");
    const openai = readFileSync(join(skillRoot, "agents", "openai.yaml"), "utf8");
    const script = readFileSync(scriptPath, "utf8");
    const reference = readFileSync(join(skillRoot, "references", "evidence-schema.md"), "utf8");

    expect(skill).toContain("when a human explicitly asks");
    expect(skill).toContain("Do not use for ordinary task context reads");
    expect(skill).toContain("manual and read-only");
    expect(skill).toContain("full set of authorized Chats is not an eligible");
    expect(skill).toContain("Never present file-read counts");
    expect(openai).toContain("$audit-context-tree-value");
    expect(script).toContain("chatId");
    expect(script).not.toContain("/Users/");
    expect(script).not.toContain("read_trace_rows");
    expect(reference).toContain("decision_bearing_normal_passage");
    expect(reference).toContain("outside_candidate_set");
    expect(AUDIT_CONTEXT_TREE_VALUE_SUITE.coverage.tiers).toMatchObject([
      { status: "implemented", tier: "floor" },
      { status: "planned", tier: "gate" },
    ]);
    expect(AUDIT_CONTEXT_TREE_VALUE_CASES.find((item) => item.tier === "gate")?.status).toBe("planned");
  });

  it("exports only the exact Chat named by an explicit authorization scope", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-scope-"));
    const scopePath = join(runRoot, "scope.json");
    const outputPath = join(runRoot, "chats.jsonl");
    const fakeCliPath = join(runRoot, "first-tree-fixture");
    const commandLogPath = join(runRoot, "commands.log");
    writeFileSync(
      scopePath,
      JSON.stringify({
        schema_version: 1,
        agents: [],
        chats: [{ chat_id: CHAT_ID, agent: "fixture-codex", agent_id: AGENT_ID, authorization: "explicit" }],
      }),
      "utf8",
    );
    writeFileSync(
      fakeCliPath,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLogPath)}, args.join(" ") + "\\n");
if (args.includes("agent") && args.includes("list")) {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: [{ name: "fixture-codex", runtime: "codex", uuid: ${JSON.stringify(AGENT_ID)} }]
  }));
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      items: [{
        id: ${JSON.stringify(MESSAGE_ID)},
        chatId: ${JSON.stringify(CHAT_ID)},
        senderId: ${JSON.stringify(AGENT_ID)},
        content: "Visible authorized message",
        createdAt: "2026-07-22T10:05:00Z"
      }],
      nextCursor: null
    }
  }));
}
`,
      "utf8",
    );
    chmodSync(fakeCliPath, 0o755);

    execFileSync("python3", [
      scriptPath,
      "export-chats",
      "--artifact-root",
      runRoot,
      "--scope",
      scopePath,
      "--first-tree-bin",
      fakeCliPath,
      "--days",
      "7",
      "--now",
      "2026-07-23T00:00:00Z",
      "--output",
      outputPath,
    ]);

    const exported = readJsonl(outputPath) as Array<{
      authorization: string;
      chat_id: string;
      messages: Array<{ message_id: string }>;
    }>;
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      authorization: "explicit",
      chat_id: CHAT_ID,
    });
    expect(exported[0]?.messages.map((message) => message.message_id)).toEqual([MESSAGE_ID]);
    const commands = readFileSync(commandLogPath, "utf8");
    expect(commands).toContain(`--json chat history ${CHAT_ID}`);
    expect(commands).not.toMatch(/\b(?:send|update|ask|create)\b/u);
  });

  it("rejects agent-list expansion without owned authorization and an exact Agent UUID", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-owned-scope-"));
    const scopePath = join(runRoot, "scope.json");
    writeFileSync(
      scopePath,
      JSON.stringify({
        schema_version: 1,
        agents: [{ name: "fixture-codex", agent_id: AGENT_ID, authorization: "explicit" }],
        chats: [],
      }),
      "utf8",
    );
    const result = spawnSync(
      "python3",
      [
        scriptPath,
        "export-chats",
        "--artifact-root",
        runRoot,
        "--scope",
        scopePath,
        "--output",
        join(runRoot, "chats.jsonl"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("authorization must be owned");
  });

  it("expands an owned Agent only after local and remote ownership checks", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-owned-agent-"));
    const scopePath = join(runRoot, "scope.json");
    const outputPath = join(runRoot, "chats.jsonl");
    const fakeCliPath = join(runRoot, "first-tree-fixture");
    writeFileSync(
      scopePath,
      JSON.stringify({
        schema_version: 1,
        agents: [{ name: "fixture-codex", agent_id: AGENT_ID, authorization: "owned" }],
        chats: [],
      }),
      "utf8",
    );
    writeFileSync(
      fakeCliPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("agent") && args.includes("list") && !args.includes("--remote")) {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: [{ name: "fixture-codex", runtime: "codex", uuid: ${JSON.stringify(AGENT_ID)} }]
  }));
} else if (args.includes("agent") && args.includes("list") && args.includes("--remote")) {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: [{
      name: "fixture-codex",
      uuid: ${JSON.stringify(AGENT_ID)},
      runtimeProvider: "codex"
    }]
  }));
} else if (args.includes("chat") && args.includes("list")) {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      items: [{ id: ${JSON.stringify(CHAT_ID)}, topic: "Owned Chat", lastMessageAt: "2026-07-22T10:05:00Z" }],
      nextCursor: null
    }
  }));
} else {
  process.stdout.write(JSON.stringify({
    ok: true,
    data: {
      items: [{
        id: ${JSON.stringify(MESSAGE_ID)},
        senderId: ${JSON.stringify(AGENT_ID)},
        content: "Owned Agent response",
        createdAt: "2026-07-22T10:05:00Z"
      }],
      nextCursor: null
    }
  }));
}
`,
      "utf8",
    );
    chmodSync(fakeCliPath, 0o755);

    execFileSync("python3", [
      scriptPath,
      "export-chats",
      "--artifact-root",
      runRoot,
      "--scope",
      scopePath,
      "--first-tree-bin",
      fakeCliPath,
      "--days",
      "7",
      "--now",
      "2026-07-23T00:00:00Z",
      "--output",
      outputPath,
    ]);
    const exported = readJsonl(outputPath) as Array<Record<string, unknown>>;
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      authorization: "owned",
      chat_id: CHAT_ID,
      source_agent: "fixture-codex",
      source_agent_id: AGENT_ID,
    });

    writeFileSync(
      fakeCliPath,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const remote = args.includes("--remote");
process.stdout.write(JSON.stringify({
  ok: true,
  data: remote
    ? [{ name: "fixture-codex", uuid: ${JSON.stringify(AGENT_TWO_ID)}, runtimeProvider: "codex" }]
    : [{ name: "fixture-codex", uuid: ${JSON.stringify(AGENT_ID)}, runtime: "codex" }]
}));
`,
      "utf8",
    );
    const collision = spawnSync(
      "python3",
      [
        scriptPath,
        "export-chats",
        "--artifact-root",
        runRoot,
        "--scope",
        scopePath,
        "--first-tree-bin",
        fakeCliPath,
        "--output",
        outputPath,
      ],
      { encoding: "utf8" },
    );
    expect(collision.status).toBe(2);
    expect(collision.stderr).toContain(`Owned agent fixture-codex (${AGENT_ID}) was not returned`);
  });

  it("pairs a representative Codex read and renders stable evidence and report artifacts", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-floor-"));
    const workspaceRoot = join(runRoot, "workspace");
    const workspaceTwoRoot = join(runRoot, "workspace-two");
    const treeRoot = join(runRoot, "arbitrary-team-tree");
    const traceRoot = join(runRoot, "sessions");
    mkdirSync(join(traceRoot, "2026", "07", "22"), { recursive: true });
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(workspaceTwoRoot, { recursive: true });
    writeWorkspaceIdentity(workspaceRoot, AGENT_ID);
    writeWorkspaceIdentity(workspaceTwoRoot, AGENT_TWO_ID);
    mkdirSync(join(treeRoot, "engineering"), { recursive: true });

    const chatsPath = join(runRoot, "chats.jsonl");
    const tracePath = join(traceRoot, "2026", "07", "22", "rollout.jsonl");
    const traceTwoPath = join(traceRoot, "2026", "07", "22", "rollout-two.jsonl");
    const candidateOne = join(runRoot, "candidates-one.jsonl");
    const candidateTwo = join(runRoot, "candidates-two.jsonl");
    const judgmentsPath = join(runRoot, "judgments.jsonl");
    const evidenceOne = join(runRoot, "evidence-one.jsonl");
    const evidenceTwo = join(runRoot, "evidence-two.jsonl");
    const reportOne = join(runRoot, "REPORT-one.md");
    const reportTwo = join(runRoot, "REPORT-two.md");

    writeJsonl(chatsPath, [
      {
        schema_version: 1,
        chat_id: CHAT_ID,
        title: "Choose one state source",
        authorization: "owned",
        source_agent: "fixture-codex-two",
        source_agent_id: AGENT_TWO_ID,
        messages: [
          {
            message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            created_at: "2026-07-22T10:05:00Z",
            sender_id: AGENT_TWO_ID,
            content: "Agent two used its own Tree read.",
          },
        ],
      },
      {
        schema_version: 1,
        chat_id: CHAT_ID,
        title: "Choose one state source",
        authorization: "owned",
        source_agent: "fixture-codex",
        source_agent_id: AGENT_ID,
        messages: [
          {
            message_id: "66666666-6666-4666-8666-666666666666",
            created_at: "2026-07-22T10:04:00Z",
            sender_id: "77777777-7777-4777-8777-777777777777",
            content: "A human mentioned Context Tree before the Agent replied.",
          },
          {
            message_id: MESSAGE_ID,
            created_at: "2026-07-22T10:05:00Z",
            sender_id: AGENT_ID,
            content:
              "The Context Tree requires Chat history to remain authoritative, so the implementation will not add a second state table.",
          },
        ],
      },
      {
        schema_version: 1,
        chat_id: OUTSIDE_CHAT_ID,
        title: "Unrelated status",
        authorization: "owned",
        source_agent: "fixture-codex",
        source_agent_id: AGENT_ID,
        messages: [
          {
            message_id: "44444444-4444-4444-8444-444444444444",
            created_at: "2026-07-22T11:00:00Z",
            sender_id: AGENT_ID,
            content: "The build completed successfully.",
          },
        ],
      },
    ]);

    const contextBlock = `<first-tree-current-chat-context format="json">\n{"chatId":"${CHAT_ID}"}\n</first-tree-current-chat-context>`;
    writeJsonl(tracePath, [
      {
        timestamp: "2026-07-22T10:00:00Z",
        type: "session_meta",
        payload: {
          cwd: workspaceRoot,
          originator: "first-tree",
          model_provider: "openai",
          source: "vscode",
        },
      },
      {
        timestamp: "2026-07-22T10:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: contextBlock }],
        },
      },
      {
        timestamp: "2026-07-22T10:02:00Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "call-tree-read",
          input: `await tools.exec_command({cmd:"nl -ba engineering/architecture.md", workdir:"${treeRoot}"})`,
        },
      },
      {
        timestamp: "2026-07-22T10:02:01Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-tree-read",
          output: "Script running with cell ID cell-1",
        },
      },
      {
        timestamp: "2026-07-22T10:02:02Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait",
          call_id: "call-tree-wait",
          arguments: JSON.stringify({ cell_id: "cell-1" }),
        },
      },
      {
        timestamp: "2026-07-22T10:02:03Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-tree-wait",
          output:
            "# Architecture\n\n## Decision\n\nChat messages are the authoritative history. Do not create a second state source.",
        },
      },
      {
        timestamp: "2026-07-22T10:02:20Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "A later turn does not repeat runtime Chat context." }],
        },
      },
      {
        timestamp: "2026-07-22T10:02:30Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec",
          call_id: "call-pending-tree-read",
          arguments: JSON.stringify({
            cmd: `cat ${join(treeRoot, "engineering", "pending.md")}`,
            workdir: workspaceRoot,
          }),
        },
      },
      {
        timestamp: "2026-07-22T10:02:31Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-pending-tree-read",
          output: "Script running with cell ID cell-pending",
        },
      },
      {
        timestamp: "2026-07-22T10:02:40Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `<first-tree-current-chat-context format="json">\n{"chatId":"${OUTSIDE_CHAT_ID}"}\n</first-tree-current-chat-context>`,
            },
          ],
        },
      },
      {
        timestamp: "2026-07-22T10:02:41Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait",
          call_id: "call-cross-chat-wait",
          arguments: JSON.stringify({ cell_id: "cell-pending" }),
        },
      },
      {
        timestamp: "2026-07-22T10:02:42Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-cross-chat-wait",
          output: "Secret continuation from a different Chat.",
        },
      },
      {
        timestamp: "2026-07-22T10:03:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `<first-tree-current-chat-context format="json">\n{"chatId":"${UNAUTHORIZED_CHAT_ID}"}\n</first-tree-current-chat-context>`,
            },
          ],
        },
      },
      {
        timestamp: "2026-07-22T10:03:01Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-unauthorized-tree-read",
          arguments: JSON.stringify({
            cmd: `cat ${join(treeRoot, "engineering", "secret.md")}`,
            workdir: workspaceRoot,
          }),
        },
      },
      {
        timestamp: "2026-07-22T10:03:02Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-unauthorized-tree-read",
          output: "Process exited with code 0\nSecret passage from another Chat.",
        },
      },
    ]);
    writeJsonl(traceTwoPath, [
      {
        timestamp: "2026-07-22T10:00:00Z",
        type: "session_meta",
        payload: {
          cwd: workspaceTwoRoot,
          originator: "first-tree",
          model_provider: "openai",
          source: "vscode",
        },
      },
      {
        timestamp: "2026-07-22T10:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: contextBlock }],
        },
      },
      {
        timestamp: "2026-07-22T10:02:00Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-agent-two-read",
          arguments: JSON.stringify({
            cmd: `cat ${join(treeRoot, "engineering", "agent-two.md")}`,
            workdir: workspaceTwoRoot,
          }),
        },
      },
      {
        timestamp: "2026-07-22T10:02:01Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-agent-two-read",
          output: "Process exited with code 0\nAgent two passage.",
        },
      },
    ]);

    const collectArguments = [
      scriptPath,
      "collect",
      "--artifact-root",
      runRoot,
      "--chats",
      chatsPath,
      "--trace-root",
      traceRoot,
      "--agent-workspace",
      `${AGENT_ID}=${workspaceRoot}`,
      "--agent-workspace",
      `${AGENT_TWO_ID}=${workspaceTwoRoot}`,
      "--tree-root",
      treeRoot,
      "--days",
      "7",
      "--now",
      "2026-07-23T00:00:00Z",
    ];
    execFileSync("python3", [...collectArguments, "--output", candidateOne]);
    execFileSync("python3", [...collectArguments, "--output", candidateTwo]);
    expect(readFileSync(candidateOne, "utf8")).toBe(readFileSync(candidateTwo, "utf8"));
    const swappedWorkspaces = spawnSync(
      "python3",
      [
        ...collectArguments.map((argument) =>
          argument === `${AGENT_ID}=${workspaceRoot}`
            ? `${AGENT_ID}=${workspaceTwoRoot}`
            : argument === `${AGENT_TWO_ID}=${workspaceTwoRoot}`
              ? `${AGENT_TWO_ID}=${workspaceRoot}`
              : argument,
        ),
        "--output",
        join(runRoot, "swapped-workspaces.jsonl"),
      ],
      { encoding: "utf8" },
    );
    expect(swappedWorkspaces.status).toBe(2);
    expect(swappedWorkspaces.stderr).toContain("Managed workspace identity does not match Agent");

    const candidates = readJsonl(candidateOne) as Array<Record<string, unknown>>;
    const candidate = candidates.find(
      (row) =>
        (row.chat as { chat_id: string; source_agent_id: string }).chat_id === CHAT_ID &&
        (row.chat as { source_agent_id: string }).source_agent_id === AGENT_ID,
    ) as {
      candidate_status: string;
      coverage_gaps: string[];
      reads: Array<{ node_paths: string[]; passage: string; read_id: string }>;
      visible_choice_candidates: Array<{ message_id: string }>;
    };
    const agentTwoCandidate = candidates.find(
      (row) =>
        (row.chat as { chat_id: string; source_agent_id: string }).chat_id === CHAT_ID &&
        (row.chat as { source_agent_id: string }).source_agent_id === AGENT_TWO_ID,
    ) as {
      reads: Array<{ node_paths: string[]; reader_agent_id: string }>;
      visible_choice_candidates: Array<{ sender_id: string }>;
    };
    const outside = candidates.find((row) => (row.chat as { chat_id: string }).chat_id === OUTSIDE_CHAT_ID) as {
      candidate_status: string;
    };
    expect(candidate.candidate_status).toBe("candidate");
    expect(candidate.reads).toHaveLength(1);
    expect(candidate.reads[0]?.node_paths).toEqual(["engineering/architecture.md"]);
    expect(candidate.reads[0]?.passage).toContain("Do not create a second state source");
    expect(candidate.coverage_gaps).toContain("tree_read_output_pending");
    expect(candidate.coverage_gaps).toContain("cross_chat_continuation_rejected");
    expect(candidate.reads.map((read) => read.passage).join("\n")).not.toContain("Secret continuation");
    expect(candidate.visible_choice_candidates.map((message) => message.message_id)).toEqual([MESSAGE_ID]);
    expect(agentTwoCandidate.reads).toMatchObject([
      { node_paths: ["engineering/agent-two.md"], reader_agent_id: AGENT_TWO_ID },
    ]);
    expect(agentTwoCandidate.visible_choice_candidates.map((message) => message.sender_id)).toEqual([AGENT_TWO_ID]);
    expect(outside.candidate_status).toBe("outside_candidate_set");

    writeJsonl(judgmentsPath, [
      {
        audit_id: AUDIT_ID,
        result: "verified",
        effect: "constrained",
        rubric: {
          real_read: true,
          decision_bearing_normal_passage: true,
          task_relevant: true,
          read_before_choice: true,
          influence_visible: true,
        },
        read_ids: [candidate.reads[0]?.read_id],
        choice_message_ids: [MESSAGE_ID],
        decision_theme: "One authoritative state source",
        summary: "The Tree constraint prevented a second state table.",
        representative: true,
        coverage_gaps: [],
      },
      {
        audit_id: AUDIT_TWO_ID,
        result: "unproven",
        effect: null,
        rubric: {
          real_read: true,
          decision_bearing_normal_passage: false,
          task_relevant: false,
          read_before_choice: true,
          influence_visible: false,
        },
        read_ids: [],
        choice_message_ids: [],
        summary: "The separation fixture does not claim semantic value for Agent two.",
        representative: false,
        coverage_gaps: [],
      },
    ]);

    const reportArguments = [
      scriptPath,
      "report",
      "--artifact-root",
      runRoot,
      "--candidates",
      candidateOne,
      "--judgments",
      judgmentsPath,
      "--generated-at",
      "2026-07-23T00:00:00Z",
    ];
    execFileSync("python3", [...reportArguments, "--evidence-output", evidenceOne, "--report-output", reportOne]);
    execFileSync("python3", [...reportArguments, "--evidence-output", evidenceTwo, "--report-output", reportTwo]);

    expect(readFileSync(evidenceOne, "utf8")).toBe(readFileSync(evidenceTwo, "utf8"));
    expect(readFileSync(reportOne, "utf8")).toBe(readFileSync(reportTwo, "utf8"));
    const report = readFileSync(reportOne, "utf8");
    expect(report).toContain("| verified | 1 |");
    expect(report).toContain("| constrained | 1 |");
    expect(report).toContain("Verified constraint hits");
    expect(report).toContain("Representative Cases");
    expect(report).toContain("Outside-candidate audit units are not `unproven`");
    expect(report).toContain("not an effective-read rate");
  });

  it("does not borrow the initial timestamp when a continuation completion lacks one", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-completion-"));
    const workspaceRoot = join(runRoot, "workspace");
    const treeRoot = join(runRoot, "tree");
    const traceRoot = join(runRoot, "sessions");
    const chatsPath = join(runRoot, "chats.jsonl");
    const outputPath = join(runRoot, "candidates.jsonl");
    mkdirSync(workspaceRoot, { recursive: true });
    writeWorkspaceIdentity(workspaceRoot, AGENT_ID);
    mkdirSync(join(treeRoot, "engineering"), { recursive: true });
    mkdirSync(traceRoot, { recursive: true });
    writeJsonl(chatsPath, [
      {
        schema_version: 1,
        chat_id: CHAT_ID,
        title: "Missing completion timestamp",
        authorization: "explicit",
        source_agent: "fixture-codex",
        source_agent_id: AGENT_ID,
        messages: [],
      },
    ]);
    writeJsonl(join(traceRoot, "rollout.jsonl"), [
      {
        timestamp: "2026-07-22T10:00:00Z",
        type: "session_meta",
        payload: {
          cwd: workspaceRoot,
          originator: "first-tree",
          model_provider: "openai",
          source: "vscode",
        },
      },
      {
        timestamp: "2026-07-22T10:01:00Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `<first-tree-current-chat-context format="json">\n{"chatId":"${CHAT_ID}"}\n</first-tree-current-chat-context>`,
            },
          ],
        },
      },
      {
        timestamp: "2026-07-22T10:02:00Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call",
          name: "exec",
          call_id: "read-call",
          input: `await tools.exec_command({cmd:"cat engineering/NODE.md", workdir:"${treeRoot}"})`,
        },
      },
      {
        timestamp: "2026-07-22T10:02:01Z",
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          call_id: "read-call",
          output: "Script running with cell ID cell-1",
        },
      },
      {
        timestamp: "2026-07-22T10:02:02Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "wait",
          call_id: "wait-call",
          arguments: JSON.stringify({ cell_id: "cell-1" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "wait-call",
          output: "# Engineering\n\n## Decision\n\nUse one state source.",
        },
      },
    ]);
    execFileSync("python3", [
      scriptPath,
      "collect",
      "--artifact-root",
      runRoot,
      "--chats",
      chatsPath,
      "--output",
      outputPath,
      "--trace-root",
      traceRoot,
      "--agent-workspace",
      `${AGENT_ID}=${workspaceRoot}`,
      "--tree-root",
      treeRoot,
      "--days",
      "7",
      "--now",
      "2026-07-23T00:00:00Z",
    ]);
    const [candidate] = readJsonl(outputPath) as Array<{
      reads: Array<{ completed_at: string | null }>;
    }>;
    expect(candidate?.reads).toHaveLength(1);
    expect(candidate?.reads[0]?.completed_at).toBeNull();
  });

  it("keeps arbitrary-domain visible references as candidates when traces are missing", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-domain-mention-"));
    const workspaceRoot = join(runRoot, "workspace");
    const treeRoot = join(runRoot, "team-tree");
    const chatsPath = join(runRoot, "chats.jsonl");
    const outputPath = join(runRoot, "candidates.jsonl");
    mkdirSync(workspaceRoot, { recursive: true });
    writeWorkspaceIdentity(workspaceRoot, AGENT_ID);
    mkdirSync(join(treeRoot, "engineering"), { recursive: true });
    writeJsonl(chatsPath, [
      {
        schema_version: 1,
        chat_id: CHAT_ID,
        title: "Arbitrary domain",
        authorization: "explicit",
        source_agent: "fixture-codex",
        source_agent_id: AGENT_ID,
        messages: [
          {
            message_id: MESSAGE_ID,
            created_at: "2026-07-22T10:05:00Z",
            sender_id: AGENT_ID,
            content: "I followed engineering/architecture.md for this choice.",
          },
        ],
      },
    ]);
    execFileSync("python3", [
      scriptPath,
      "collect",
      "--artifact-root",
      runRoot,
      "--chats",
      chatsPath,
      "--output",
      outputPath,
      "--trace-root",
      join(runRoot, "missing-sessions"),
      "--agent-workspace",
      `${AGENT_ID}=${workspaceRoot}`,
      "--tree-root",
      treeRoot,
      "--days",
      "7",
      "--now",
      "2026-07-23T00:00:00Z",
    ]);
    const [candidate] = readJsonl(outputPath) as Array<{
      candidate_status: string;
      coverage_gaps: string[];
      visible_tree_mentions: unknown[];
    }>;
    expect(candidate?.candidate_status).toBe("candidate");
    expect(candidate?.visible_tree_mentions).toHaveLength(1);
    expect(candidate?.coverage_gaps).toContain("no_mapped_codex_trace");
  });

  it("fails closed when probable evidence satisfies the verified bar", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-invalid-"));
    const candidatesPath = join(runRoot, "candidates.jsonl");
    const judgmentsPath = join(runRoot, "judgments.jsonl");
    writeJsonl(candidatesPath, [
      {
        schema_version: 1,
        audit_id: AUDIT_ID,
        chat: { chat_id: CHAT_ID, title: "fixture", authorization: "owned", message_count: 0 },
        window: { start: "2026-07-16T00:00:00Z", end: "2026-07-23T00:00:00Z" },
        candidate_status: "candidate",
        mapped_trace_files: [],
        reads: [],
        visible_choice_candidates: [],
        visible_tree_mentions: [],
        coverage_gaps: [],
      },
    ]);
    writeJsonl(judgmentsPath, [
      {
        audit_id: AUDIT_ID,
        result: "probable",
        effect: "confirmed",
        rubric: Object.fromEntries([
          ["real_read", true],
          ["decision_bearing_normal_passage", true],
          ["task_relevant", true],
          ["read_before_choice", true],
          ["influence_visible", true],
        ]),
        read_ids: [],
        choice_message_ids: [],
        summary: "Invalid probable row.",
      },
    ]);

    const result = spawnSync(
      "python3",
      [
        scriptPath,
        "report",
        "--artifact-root",
        runRoot,
        "--candidates",
        candidatesPath,
        "--judgments",
        judgmentsPath,
        "--evidence-output",
        join(runRoot, "evidence.jsonl"),
        "--report-output",
        join(runRoot, "REPORT.md"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("satisfies the verified bar");
  });

  it("rejects evidence-free positive judgments and read-after-choice claims", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-positive-proof-"));
    const candidatesPath = join(runRoot, "candidates.jsonl");
    const judgmentsPath = join(runRoot, "judgments.jsonl");
    const baseCandidate = {
      schema_version: 1,
      audit_id: AUDIT_ID,
      chat: { chat_id: CHAT_ID, title: "fixture", authorization: "owned", message_count: 1 },
      window: { start: "2026-07-16T00:00:00Z", end: "2026-07-23T00:00:00Z" },
      candidate_status: "candidate",
      mapped_trace_files: ["trace.jsonl"],
      reads: [
        {
          read_id: "read-one",
          timestamp: "2026-07-22T10:00:00Z",
          completed_at: "2026-07-22T10:06:00Z",
          success: true,
          node_paths: ["engineering/NODE.md"],
          passage: "A decision-bearing passage.",
        },
      ],
      visible_choice_candidates: [
        {
          message_id: MESSAGE_ID,
          created_at: "2026-07-22T10:05:00Z",
          sender_id: AGENT_ID,
          content: "The visible choice.",
        },
      ],
      visible_tree_mentions: [],
      coverage_gaps: [],
    };
    writeJsonl(candidatesPath, [baseCandidate]);
    const rubric = {
      real_read: true,
      decision_bearing_normal_passage: true,
      task_relevant: true,
      read_before_choice: true,
      influence_visible: true,
    };
    writeJsonl(judgmentsPath, [
      {
        audit_id: AUDIT_ID,
        result: "verified",
        effect: "confirmed",
        rubric,
        read_ids: [],
        choice_message_ids: [],
        summary: "No cited proof.",
      },
    ]);
    const common = [
      scriptPath,
      "report",
      "--artifact-root",
      runRoot,
      "--candidates",
      candidatesPath,
      "--judgments",
      judgmentsPath,
      "--evidence-output",
      join(runRoot, "evidence.jsonl"),
      "--report-output",
      join(runRoot, "REPORT.md"),
    ];
    const evidenceFree = spawnSync("python3", common, { encoding: "utf8" });
    expect(evidenceFree.status).toBe(2);
    expect(evidenceFree.stderr).toContain("requires at least one read ID");

    writeJsonl(judgmentsPath, [
      {
        audit_id: AUDIT_ID,
        result: "verified",
        effect: "confirmed",
        rubric,
        read_ids: ["read-one"],
        choice_message_ids: [MESSAGE_ID],
        summary: "Timing claim is invalid.",
      },
    ]);
    const invalidTiming = spawnSync("python3", common, { encoding: "utf8" });
    expect(invalidTiming.status).toBe(2);
    expect(invalidTiming.stderr).toContain("completed after the earliest cited choice");

    writeJsonl(judgmentsPath, [
      {
        audit_id: AUDIT_ID,
        result: "probable",
        effect: "confirmed",
        rubric: { ...rubric, read_before_choice: false, influence_visible: false },
        read_ids: ["read-one"],
        choice_message_ids: [MESSAGE_ID],
        summary: "A post-choice read cannot be probable value.",
      },
    ]);
    const postChoiceProbable = spawnSync("python3", common, { encoding: "utf8" });
    expect(postChoiceProbable.status).toBe(2);
    expect(postChoiceProbable.stderr).toContain(
      "requires real read, normal passage, relevance, and read-before-choice",
    );

    writeJsonl(candidatesPath, [
      {
        ...baseCandidate,
        reads: [{ ...baseCandidate.reads[0], completed_at: null }],
      },
    ]);
    writeJsonl(judgmentsPath, [
      {
        audit_id: AUDIT_ID,
        result: "verified",
        effect: "confirmed",
        rubric,
        read_ids: ["read-one"],
        choice_message_ids: [MESSAGE_ID],
        summary: "A missing completion timestamp cannot prove timing.",
      },
    ]);
    const missingCompletion = spawnSync("python3", common, { encoding: "utf8" });
    expect(missingCompletion.status).toBe(2);
    expect(missingCompletion.stderr).toContain("without completion timestamps");
  });

  it("rejects symlinked artifact outputs", () => {
    runRoot = mkdtempSync(join(tmpdir(), "ft-value-audit-symlink-"));
    const scopePath = join(runRoot, "scope.json");
    const targetPath = join(runRoot, "target.jsonl");
    const outputPath = join(runRoot, "chats.jsonl");
    writeFileSync(
      scopePath,
      JSON.stringify({
        schema_version: 1,
        agents: [],
        chats: [{ chat_id: CHAT_ID, agent: "fixture-codex", agent_id: AGENT_ID, authorization: "explicit" }],
      }),
      "utf8",
    );
    writeFileSync(targetPath, "do not overwrite\n", "utf8");
    symlinkSync(targetPath, outputPath);
    const result = spawnSync(
      "python3",
      [scriptPath, "export-chats", "--artifact-root", runRoot, "--scope", scopePath, "--output", outputPath],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not be a symbolic link");
    expect(readFileSync(targetPath, "utf8")).toBe("do not overwrite\n");
  });
});
