import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type ProviderRetryEventPayload, parseProviderRetryEventMessage, type SessionEvent } from "@first-tree/shared";
import { describe, expect, it } from "vitest";
import {
  classifyCursorNoResult,
  consumeCursorEvent,
  createCursorTurnState,
  evaluateCursorNoResult,
  finalizeCursorBinaryMissing,
  finalizeCursorResult,
} from "./parser.js";

/** Decode the structured provider-retry event SessionManager reads for the durable notice. */
function structuredRetryEvent(events: SessionEvent[]): ProviderRetryEventPayload | null {
  for (const event of events) {
    if (event.kind !== "error") continue;
    const payload = parseProviderRetryEventMessage(event.payload.message);
    if (payload) return payload;
  }
  return null;
}

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf-8");
}

function parseJsonlLines(text: string): unknown[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

/** Drive a whole jsonl fixture through the parser, returning streamed events. */
function streamFixture(name: string): { events: SessionEvent[]; state: ReturnType<typeof createCursorTurnState> } {
  const state = createCursorTurnState();
  const events: SessionEvent[] = [];
  for (const raw of parseJsonlLines(fixture(name))) {
    events.push(...consumeCursorEvent(state, raw));
  }
  return { events, state };
}

function toolCalls(events: SessionEvent[]): Array<Extract<SessionEvent, { kind: "tool_call" }>["payload"]> {
  return events
    .filter((e): e is Extract<SessionEvent, { kind: "tool_call" }> => e.kind === "tool_call")
    .map((e) => e.payload);
}

const EDIT_CALL_ID = "tool_28d67f7a-14e6-4ec2-9e0e-8bd077528d8";
const READ_CALL_ID = "tool_5fea06e6-7ec1-450a-a642-c7a6000d389";
const SHELL_CALL_ID = "tool_c5cb272a-f951-41f9-a165-be2e3edc29d";

describe("cursor parser — multitool success", () => {
  it("emits thinking markers, paired tool calls, usage, assistant text, and a success turn_end", () => {
    const { events, state } = streamFixture("multitool-success.jsonl");

    // Two `thinking:completed` blocks → two presence-only markers (deltas dropped).
    expect(events.filter((e) => e.kind === "thinking")).toHaveLength(2);

    // No assistant_text emitted during the stream — it is deferred to finalize.
    expect(events.some((e) => e.kind === "assistant_text")).toBe(false);

    // Tool calls, in emitted order, paired by call_id across the interleave.
    const calls = toolCalls(events);
    expect(calls.map((c) => [c.toolUseId, c.name, c.status])).toEqual([
      [EDIT_CALL_ID, "edit", "pending"],
      [EDIT_CALL_ID, "edit", "ok"],
      [READ_CALL_ID, "read", "pending"],
      [SHELL_CALL_ID, "shell", "pending"],
      [READ_CALL_ID, "read", "ok"],
      [SHELL_CALL_ID, "shell", "ok"],
    ]);

    // Terminal edit: file_change ref + duration + message preview.
    const editDone = calls.find((c) => c.toolUseId === EDIT_CALL_ID && c.status === "ok");
    expect(editDone?.toolFileRefs).toEqual([
      {
        localPath: "/private/tmp/cursor-cli-multitool-xm1EqH/phase0-proof.txt",
        pathKind: "file",
        origin: "file_change",
      },
    ]);
    expect(editDone?.durationMs).toBe(382);
    expect(editDone?.resultPreview).toBe("Wrote contents to /private/tmp/cursor-cli-multitool-xm1EqH/phase0-proof.txt");

    // Terminal read: tool_arg ref + "<bytes> bytes" preview.
    const readDone = calls.find((c) => c.toolUseId === READ_CALL_ID && c.status === "ok");
    expect(readDone?.toolFileRefs).toEqual([
      { localPath: "/private/tmp/cursor-cli-multitool-xm1EqH/phase0-proof.txt", pathKind: "file", origin: "tool_arg" },
    ]);
    expect(readDone?.resultPreview).toBe("46 bytes");

    // Terminal shell (success): stdout preview, no file refs.
    const shellDone = calls.find((c) => c.toolUseId === SHELL_CALL_ID && c.status === "ok");
    expect(shellDone?.resultPreview).toBe("      46 phase0-proof.txt\n");
    expect(shellDone?.toolFileRefs).toBeUndefined();

    // State captured from system:init and result.
    expect(state.sessionId).toBe("b4b94c7c-fafd-4445-aa91-2b6da9e2a503");
    expect(state.model).toBe("Composer 2.5");
    expect(state.sawResult).toBe(true);
    expect(state.isError).toBe(false);

    // Finalize: token_usage → assistant_text → turn_end, in that order.
    const { events: finalEvents, settlement } = finalizeCursorResult(state, {});
    expect(finalEvents.map((e) => e.kind)).toEqual(["token_usage", "assistant_text", "turn_end"]);

    const usage = finalEvents.find((e) => e.kind === "token_usage");
    expect(usage?.kind === "token_usage" && usage.payload).toEqual({
      provider: "cursor",
      model: "Composer 2.5",
      inputTokens: 4358,
      cachedInputTokens: 32896,
      outputTokens: 408,
    });

    // assistant_text equals the aggregated `result.result` string exactly.
    const resultLine = parseJsonlLines(fixture("multitool-success.jsonl")).find(
      (e): e is { type: string; result: string } =>
        typeof e === "object" && e !== null && "type" in e && (e as { type: unknown }).type === "result",
    );
    const expectedText = "Creating the file, reading it back, then running `wc -c`.\nFT_MULTITOOL_OK";
    expect(resultLine?.result).toBe(expectedText);
    const assistantText = finalEvents.find((e) => e.kind === "assistant_text");
    expect(assistantText?.kind === "assistant_text" && assistantText.payload.text).toBe(expectedText);

    const turnEnd = finalEvents.find((e) => e.kind === "turn_end");
    expect(turnEnd?.kind === "turn_end" && turnEnd.payload.status).toBe("success");

    expect(settlement.action.kind).toBe("complete");
    expect(settlement.status).toBe("success");
  });
});

describe("cursor parser — shell failure (completed line)", () => {
  it("marks a shell exit-nonzero tool call as error with the stderr in the preview", () => {
    const state = createCursorTurnState();
    const raw = JSON.parse(fixture("shell-failure-completed.json"));
    const events = consumeCursorEvent(state, raw);

    expect(events).toHaveLength(1);
    const call = events[0];
    expect(call?.kind).toBe("tool_call");
    if (call?.kind !== "tool_call") throw new Error("expected tool_call");
    expect(call.payload.name).toBe("shell");
    expect(call.payload.status).toBe("error");
    expect(call.payload.toolUseId).toBe("tool_8f1d4c42-bfec-4d64-a4d3-113840a50c4");
    expect(call.payload.resultPreview).toBe("FT_EXPECTED_STDERR");
    expect(call.payload.durationMs).toBe(638);
  });
});

describe("cursor parser — writeToolCall (file creation)", () => {
  it("maps writeToolCall to a canonical WRITE with a file_change ref", () => {
    const state = createCursorTurnState();
    const raw = JSON.parse(fixture("write-tool-completed.json"));
    const events = consumeCursorEvent(state, raw);

    expect(events).toHaveLength(1);
    const call = events[0];
    if (call?.kind !== "tool_call") throw new Error("expected tool_call");
    expect(call.payload.name).toBe("write");
    expect(call.payload.status).toBe("ok");
    expect(call.payload.durationMs).toBe(420);
    expect(call.payload.resultPreview).toBe("Created /private/tmp/cursor-cli-write-Xk2/created.txt");
    // A created file must carry a write (file_change) ref so the server derives IO.
    expect(call.payload.toolFileRefs).toEqual([
      { localPath: "/private/tmp/cursor-cli-write-Xk2/created.txt", pathKind: "file", origin: "file_change" },
    ]);
  });
});

describe("cursor parser — no-result finalize classification", () => {
  const AUTH_STDERR =
    "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.";
  const INVALID_MODEL_STDERR = "Cannot use this model: bogus-model. Available models: auto, gpt-5.3-codex-low";
  const USAGE_LIMIT_STDERR =
    "ActionRequiredError: You've hit your usage limit You've saved $48 on API model usage this month with Pro.";

  it("classifies the three terminal no-result cases", () => {
    expect(classifyCursorNoResult(AUTH_STDERR)).toBe("auth");
    expect(classifyCursorNoResult(INVALID_MODEL_STDERR)).toBe("invalid_model");
    expect(classifyCursorNoResult(USAGE_LIMIT_STDERR)).toBe("usage_limit");
    expect(classifyCursorNoResult("network blip, please retry")).toBe("generic");
  });

  it("auth → structured terminal event (credential) + human hint + terminal consumed settlement", () => {
    const disposition = evaluateCursorNoResult(createCursorTurnState(), 1, AUTH_STDERR, 1);
    if (disposition.action !== "settle") throw new Error("expected settle");
    const { events, settlement } = disposition;
    // structured provider-retry event first, then the human-readable error, then turn_end.
    expect(events.map((e) => e.kind)).toEqual(["error", "error", "turn_end"]);

    // Structured event: SessionManager turns this into the durable chat notice.
    const structured = structuredRetryEvent(events);
    expect(structured?.event).toBe("provider_failure_terminal");
    expect(structured?.provider).toBe("cursor");
    expect(structured?.category).toBe("credential");

    // Human-readable error carries the re-login hint.
    const human = events.find((e) => e.kind === "error" && !e.payload.message.startsWith("provider.retry:"));
    expect(human?.kind === "error" && human.payload.source).toBe("sdk");
    expect(human?.kind === "error" && human.payload.message).toContain("cursor-agent login");
    expect(human?.kind === "error" && human.payload.message).toContain("Authentication required");

    const turnEnd = events.find((e) => e.kind === "turn_end");
    expect(turnEnd?.kind === "turn_end" && turnEnd.payload.status).toBe("error");
    expect(settlement.action.kind).toBe("complete");
    expect(settlement.status).toBe("error");
    if (settlement.action.kind !== "complete") throw new Error("expected complete");
    expect(settlement.action.outcome).toMatchObject({ terminal: true, completion: "consumed" });
  });

  it("invalid model → structured terminal event (configuration) + terminal consumed settlement", () => {
    const disposition = evaluateCursorNoResult(createCursorTurnState(), 1, INVALID_MODEL_STDERR, 1);
    if (disposition.action !== "settle") throw new Error("expected settle");
    const structured = structuredRetryEvent(disposition.events);
    expect(structured?.event).toBe("provider_failure_terminal");
    expect(structured?.category).toBe("configuration");
    const human = disposition.events.find(
      (e) => e.kind === "error" && !e.payload.message.startsWith("provider.retry:"),
    );
    expect(human?.kind === "error" && human.payload.message).toBe(INVALID_MODEL_STDERR);
    expect(disposition.settlement.action.kind).toBe("complete");
    expect(disposition.settlement.status).toBe("error");
  });

  it("usage limit → structured terminal event (provider_capacity) + terminal consumed settlement", () => {
    // Usage limit implies the provider was reached → provider_entered → terminal.
    const state = createCursorTurnState();
    state.sawInit = true;
    const disposition = evaluateCursorNoResult(state, 1, USAGE_LIMIT_STDERR, 1);
    if (disposition.action !== "settle") throw new Error("expected settle");
    const structured = structuredRetryEvent(disposition.events);
    expect(structured?.event).toBe("provider_failure_terminal");
    expect(structured?.category).toBe("provider_capacity");
    const human = disposition.events.find(
      (e) => e.kind === "error" && !e.payload.message.startsWith("provider.retry:"),
    );
    expect(human?.kind === "error" && human.payload.message).toBe(USAGE_LIMIT_STDERR);
    expect(disposition.settlement.action.kind).toBe("complete");
    expect(disposition.settlement.status).toBe("error");
  });

  it("generic exit with NO tool effect → foreground RETRY disposition (attempt 1)", () => {
    const disposition = evaluateCursorNoResult(createCursorTurnState(), 2, "", 1);
    if (disposition.action !== "retry") throw new Error("expected retry");
    expect(disposition.delayMs).toBeGreaterThan(0);
    // The scheduled (non-terminal) structured event drives the "retrying" status,
    // and shouldPost... returns false for it (no premature durable notice).
    const structured = structuredRetryEvent([disposition.scheduledEvent]);
    expect(structured?.event).toBe("provider_retry_scheduled");
  });

  it("generic exit exhausted (later attempt, pre-provider) → hand back to inbox (retry settlement)", () => {
    // Attempt beyond the unknown-retry budget → stop(exhausted); pre_provider →
    // recover via the inbox rather than dropping the message as consumed.
    const disposition = evaluateCursorNoResult(createCursorTurnState(), 2, "", 5);
    if (disposition.action !== "settle") throw new Error("expected settle");
    const structured = structuredRetryEvent(disposition.events);
    expect(structured?.event).toBe("provider_retry_exhausted");
    expect(disposition.settlement.action.kind).toBe("retry");
  });

  it("generic exit AFTER a tool effect → terminal consumed (never replays a side effect)", () => {
    // A tool_call already ran (edit/shell) before the CLI crashed pre-result:
    // replay would re-apply the effect, so this must NOT retry even at attempt 1.
    const state = createCursorTurnState();
    state.sawInit = true;
    state.sawToolEffect = true;
    const disposition = evaluateCursorNoResult(state, 139, "segfault", 1);
    if (disposition.action !== "settle") throw new Error("expected settle");
    const structured = structuredRetryEvent(disposition.events);
    expect(structured?.event).toBe("provider_failure_terminal");
    expect(structured?.replaySafety).toBe("user_visible");
    expect(disposition.settlement.action.kind).toBe("complete");
    expect(disposition.settlement.status).toBe("error");
    if (disposition.settlement.action.kind !== "complete") throw new Error("expected complete");
    expect(disposition.settlement.action.outcome).toMatchObject({ terminal: true, completion: "consumed" });
  });

  it("result with is_error → consumed error settlement + error turn_end", () => {
    const state = createCursorTurnState();
    state.sawResult = true;
    state.isError = true;
    state.resultText = "partial";
    const { events, settlement } = finalizeCursorResult(state, {});
    // No usage captured → no token_usage; assistant_text still carries the text.
    expect(events.map((e) => e.kind)).toEqual(["assistant_text", "turn_end"]);
    const turnEnd = events.find((e) => e.kind === "turn_end");
    expect(turnEnd?.kind === "turn_end" && turnEnd.payload.status).toBe("error");
    expect(settlement.action.kind).toBe("complete");
    expect(settlement.status).toBe("error");
  });

  it("missing binary → terminal capability event + consumed settlement (finding 3)", () => {
    const { events, settlement } = finalizeCursorBinaryMissing("Cursor runtime binary is missing on this machine.");
    const structured = structuredRetryEvent(events);
    expect(structured?.event).toBe("provider_failure_terminal");
    expect(structured?.category).toBe("capability");
    expect(events.map((e) => e.kind)).toEqual(["error", "error", "turn_end"]);
    expect(settlement.action.kind).toBe("complete");
    expect(settlement.status).toBe("error");
    if (settlement.action.kind !== "complete") throw new Error("expected complete");
    expect(settlement.action.outcome).toMatchObject({ terminal: true, completion: "consumed" });
  });
});
