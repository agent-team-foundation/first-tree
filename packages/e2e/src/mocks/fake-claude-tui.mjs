#!/usr/bin/env node
// Fake `claude` TUI for e2e — pretends to be the upstream `claude` CLI run
// interactively inside a tmux pane. Designed for the `claude-code-tui` handler
// (packages/client/src/handlers/claude-code-tui/), NOT the SDK path.
//
// The handler drives this binary by:
//   1. Spawning it inside `tmux new-session -d -s <name> ... <cmd>`. Fresh
//      starts include `--session-id <uuid>`; resumes include `--resume <uuid>`.
//      Both identify the transcript file to write to (per real Claude's
//      behaviour — see transcript-tail.ts).
//   2. Polling `tmux capture-pane` for the `bypass permissions on` ready
//      marker, the `❯ ` prompt, and the `esc to interrupt` working marker.
//   3. Sending user text via `paste-buffer -p` + `send-keys Enter`.
//   4. Reading transcript events from
//      `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` to pick up
//      assistant text + tool_use blocks (the format produced by real Claude).
//
// So this fake must:
//   * Paint the pane with the four magic strings on the right state transitions.
//   * Accept paste-buffer input on stdin (terminal default cooked-mode is OK
//     — Enter terminates each user submission).
//   * Append properly-shaped Anthropic message JSON to the transcript file
//     on every turn, in the same path the handler computes.
//   * React to ESC (handler sends one Escape to interrupt a hung turn).
//
// Behaviour env knobs (read once at startup; per-turn overrides via the
// FAKE_TUI_LOG side channel are not needed — tests inject the right knob
// per agent via FIRST_TREE_HOME-scoped env):
//
//   FAKE_TUI_REPLY                — canned reply text (default: echoes input)
//   FAKE_TUI_DELAY_MS             — pre-emit delay; useful for timeout tests
//   FAKE_TUI_FAIL_READY=1         — never print the ready marker (probe a
//                                   waitForReady timeout)
//   FAKE_TUI_HANG=1               — receive input then never finish the turn
//                                   (probe TURN_TIMEOUT_MS path)
//   FAKE_TUI_CRASH_AFTER_TURNS=N  — exit non-zero after N completed turns
//                                   (probe crash-recovery scenarios)
//   FAKE_TUI_TOOL_CALL=1          — first turn emits a Bash tool_use + a
//                                   matching tool_result (probe tool_call
//                                   plumbing through the shared processor).
//   FAKE_TUI_LOG_PATH             — append one JSON line per fake event
//                                   (start, ready, turn:start, turn:end,
//                                   crash). Tests read this via
//                                   fake-tui-log.ts.
//
// Why hand-rolled and not a fixture lib: the handler observes BOTH pane text
// and transcript JSONL, and the contract between them is what we want to
// exercise. A library would hide one or the other.

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
function readFlag(name) {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

// Capability probe (probeClaudeCodeTuiCapability) calls `claude --version`
// before considering the binary "runnable". Handle it short-circuit so the
// daemon's startup probe accepts the fake. Match the dotted-number triplet
// real claude prints (the probe regex /\d+\.\d+(?:\.\d+)?/ accepts either).
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("9.9.9 (fake-tui)\n");
  process.exit(0);
}

const resumeId = readFlag("--resume") ?? null;
const sessionId = readFlag("--session-id") ?? resumeId ?? randomUUID();

const REPLY = process.env.FAKE_TUI_REPLY ?? null;
const DELAY_MS = Number(process.env.FAKE_TUI_DELAY_MS ?? "0");
const FAIL_READY = process.env.FAKE_TUI_FAIL_READY === "1";
const HANG = process.env.FAKE_TUI_HANG === "1";
const CRASH_AFTER = Number(process.env.FAKE_TUI_CRASH_AFTER_TURNS ?? "0");
const TOOL_CALL = process.env.FAKE_TUI_TOOL_CALL === "1";
const LOG_PATH = process.env.FAKE_TUI_LOG_PATH ?? null;

// Same magic strings the handler matches against (see tui-markers.ts).
// Keep these in sync if the handler markers ever change.
const READY_MARKER = "bypass permissions on";
const WORKING_MARKER = "esc to interrupt";

function logEvent(kind, extra) {
  if (!LOG_PATH) return;
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(
      LOG_PATH,
      `${JSON.stringify({
        kind,
        sessionId,
        resumeId,
        ts: new Date().toISOString(),
        pid: process.pid,
        ...extra,
      })}\n`,
    );
  } catch {
    // never let logging tip a test over
  }
}

/**
 * Path real Claude writes its per-session transcript to. Matches
 * transcript-tail.ts:transcriptPathFor exactly.
 */
function transcriptPathFor(cwd, id) {
  const absCwd = resolve(cwd);
  const encoded = `-${absCwd.replace(/^\//, "").replace(/[/.]/g, "-")}`;
  return join(homedir(), ".claude", "projects", encoded, `${id}.jsonl`);
}

const transcriptPath = transcriptPathFor(process.cwd(), sessionId);
mkdirSync(dirname(transcriptPath), { recursive: true });
// Don't truncate on --resume: the handler is reusing the session, so we
// want to preserve any prior history (the real Claude appends across
// resumes). On a fresh start, ensure an empty file so the tailer's
// existsSync check is true from t0.
if (!existsSync(transcriptPath)) writeFileSync(transcriptPath, "");

function appendTranscript(entry) {
  appendFileSync(transcriptPath, `${JSON.stringify(entry)}\n`);
}

/** Paint helpers — write directly to stdout, which tmux captures into its pane buffer. */
function paint(line) {
  process.stdout.write(`${line}\n`);
}

/** Best-effort sleep that yields the event loop. */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Read a single user message from stdin. tmux paste-buffer -p wraps the
 * pasted text in bracketed-paste markers (`\e[200~ ... \e[201~`) and a
 * separate send-keys Enter terminates the submission. We collect bytes until
 * a CR/LF arrives outside the brackets, then strip the markers and any other
 * ANSI escape sequences, returning the clean text.
 *
 * Also handles `Escape` (0x1b alone): resolves with the sentinel
 * `{ kind: "escape" }` so the caller can treat it as a turn interrupt.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function readNextInput() {
  return new Promise((resolveInput) => {
    // `raw` holds unprocessed bytes; `pending` accumulates the text of the
    // submission-in-progress (paste content with internal newlines preserved
    // + any typed chars). A bracketed-paste block is consumed as a single
    // unit so the newlines inside the runtime's `[From: name]\n<body>` inject
    // are NOT mistaken for the terminating Enter — only the separate
    // `send-keys Enter` (a bare CR arriving after the paste) submits.
    let raw = "";
    let pending = "";
    let inPaste = false;
    // `send-keys Escape` delivers a BARE 0x1b with no follow-on byte, so a
    // trailing lone ESC can't be distinguished from the first byte of a CSI
    // sequence (`\x1b[…`) by inspection alone. We arm a short grace timer:
    // if the ESC is still trailing + unaccompanied when it fires, it was a
    // real Escape keypress (the handler's hung-turn interrupt).
    let escapeTimer = null;
    const armEscapeTimer = () => {
      if (escapeTimer) return;
      escapeTimer = setTimeout(() => {
        escapeTimer = null;
        const escIdx = raw.indexOf("\x1b");
        if (escIdx >= 0 && raw[escIdx + 1] !== "[" && escIdx + 1 >= raw.length) {
          raw = raw.slice(0, escIdx);
          cleanup();
          resolveInput({ kind: "escape" });
        }
      }, 60);
    };
    const onData = (chunk) => {
      raw += chunk.toString("utf-8");
      for (;;) {
        if (inPaste) {
          const end = raw.indexOf(PASTE_END);
          if (end < 0) {
            // No end marker yet. Move all but a small tail into pending so a
            // PASTE_END split across two chunks still matches next time.
            if (raw.length > PASTE_END.length) {
              pending += raw.slice(0, raw.length - PASTE_END.length);
              raw = raw.slice(raw.length - PASTE_END.length);
            }
            return;
          }
          pending += raw.slice(0, end);
          raw = raw.slice(end + PASTE_END.length);
          inPaste = false;
          continue;
        }

        const startIdx = raw.indexOf(PASTE_START);
        const crIdx = raw.search(/[\r\n]/);
        const escIdx = raw.indexOf("\x1b");

        // A lone Escape (send-keys Escape → a bare 0x1b) that is NOT the start
        // of a CSI sequence. If 0x1b is the last byte we have, wait one tick
        // for a possible `[200~` to land before deciding.
        if (escIdx >= 0 && (startIdx < 0 || escIdx < startIdx)) {
          const isCsi = raw[escIdx + 1] === "[";
          if (!isCsi) {
            if (escIdx + 1 >= raw.length) {
              // Trailing lone ESC — could be a real Escape keypress or the
              // start of a CSI seq whose `[` hasn't landed yet. Arm the grace
              // timer to decide, then wait for more bytes.
              armEscapeTimer();
              return;
            }
            // ESC followed by a non-`[` byte → a real Escape keypress.
            raw = raw.slice(0, escIdx) + raw.slice(escIdx + 1);
            cleanup();
            resolveInput({ kind: "escape" });
            return;
          }
        }

        // Begin a bracketed-paste block: typed text before it is kept.
        if (startIdx >= 0 && (crIdx < 0 || startIdx < crIdx)) {
          pending += stripEscapes(raw.slice(0, startIdx));
          raw = raw.slice(startIdx + PASTE_START.length);
          inPaste = true;
          continue;
        }

        // No paste markers ahead of the next Enter: a CR/LF submits whatever
        // is pending (+ any typed text before it).
        if (crIdx < 0) return; // not yet
        pending += stripEscapes(raw.slice(0, crIdx));
        raw = raw.slice(crIdx + 1);
        const submitted = pending.trim();
        pending = "";
        if (submitted.length === 0) {
          // Bare Enter with nothing pending — keep waiting.
          continue;
        }
        cleanup();
        resolveInput({ kind: "text", text: submitted });
        return;
      }
    };
    const cleanup = () => {
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
    };
    const onEnd = () => {
      cleanup();
      resolveInput({ kind: "eof" });
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      try {
        process.stdin.setRawMode(true);
      } catch {
        /* not a real tty — best-effort */
      }
    }
    process.stdin.resume();
  });
}

function stripEscapes(s) {
  // Strip bracketed paste markers and other CSI sequences. The control
  // character is intentional — that's exactly what we're matching out of
  // the input stream.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC by design
  return s.replace(/\x1b\[\d*(?:;\d*)*[a-zA-Z~]/g, "").replace(/\x1b/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Clear the pane (screen + scrollback + cursor home). Critical for emulating
 * claude's live status line: the handler decides a turn is still in flight by
 * `capture-pane`-ing the pane and testing for the WORKING_MARKER substring.
 * Real claude prints `esc to interrupt` on a status line that it ERASES when
 * the turn completes. If the fake merely prints the marker and leaves it in
 * the scrollback, `pane.includes(WORKING_MARKER)` stays true forever and the
 * handler waits out the full TURN_TIMEOUT. Clearing before each state repaint
 * makes the marker actually disappear when we transition to idle.
 */
function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
}

async function runOneTurn(turnIndex, userText) {
  logEvent("turn:start", { turn: turnIndex, userText });

  // Record the user input in the transcript first (mirrors real Claude).
  appendTranscript({
    type: "user",
    message: { role: "user", content: userText },
    timestamp: nowIso(),
    uuid: randomUUID(),
    sessionId,
  });

  // Switch to working state: clear the pane, then paint ONLY the working
  // marker so a poll landing here sees an in-flight turn. The later idle/reply
  // repaint clears this away — that disappearance is the turn-end signal.
  clearScreen();
  paint(WORKING_MARKER);
  await sleep(DELAY_MS);

  // Hang knob — never produce output / never return.
  if (HANG) {
    logEvent("turn:hang", { turn: turnIndex });
    await new Promise(() => {});
    return;
  }

  // Knob: emit a tool_call (Bash) + tool_result, then a normal text reply.
  if (TOOL_CALL && turnIndex === 1) {
    const toolUseId = `toolu_${randomUUID().replace(/-/g, "")}`;
    appendTranscript({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command: "echo hi" } }],
      },
      timestamp: nowIso(),
      uuid: randomUUID(),
      sessionId,
    });
    appendTranscript({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: "hi", is_error: false }],
      },
      timestamp: nowIso(),
      uuid: randomUUID(),
      sessionId,
    });
  }

  // Compose + emit the assistant text reply.
  const replyText = REPLY ?? `fake-tui echo (turn ${turnIndex}): ${userText}`;
  appendTranscript({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: replyText }] },
    timestamp: nowIso(),
    uuid: randomUUID(),
    sessionId,
  });
  // Clear the working marker and paint the assistant reply line + idle prompt.
  // The handler reads the reply TEXT from the transcript (above), not the pane;
  // this repaint exists so `pane.includes(WORKING_MARKER)` flips false, which
  // is how the handler detects turn-end.
  clearScreen();
  paint(`⏺ ${replyText}`);
  paint("❯ "); // NBSP: tmux capture-pane trims trailing ASCII space, NBSP survives — handler's USER_RE matches either
  logEvent("turn:end", { turn: turnIndex, replyText });
}

async function main() {
  logEvent("start", { argv: process.argv, cwd: process.cwd(), transcriptPath });

  if (FAIL_READY) {
    // Never paint the ready marker — handler's waitForReady should time out.
    paint("(fake-tui FAIL_READY: never advertising ready)");
    await new Promise(() => {});
    return;
  }

  // Enable bracketed paste mode (DECSET 2004). Tmux only wraps `paste-buffer
  // -p` content in `\x1b[200~ ... \x1b[201~` when the receiving application
  // asks for it. Without this, internal newlines in the pasted message (e.g.
  // the `[From: name]\n<body>` shape the runtime prepends) are treated as
  // submission boundaries and the fake processes only the first line.
  process.stdout.write("\x1b[?2004h");
  // Paint the ready surface: bypass-permissions marker + the `❯ ` prompt
  // line. waitForReady requires both.
  paint(READY_MARKER);
  paint("❯ "); // NBSP: tmux capture-pane trims trailing ASCII space, NBSP survives — handler's USER_RE matches either
  logEvent("ready");

  let turn = 0;
  for (;;) {
    const next = await readNextInput();
    if (next.kind === "eof") {
      logEvent("eof");
      break;
    }
    if (next.kind === "escape") {
      // Standalone Escape outside a turn (e.g. handler interrupting hang).
      // Repaint the prompt and continue.
      paint("❯ "); // NBSP: tmux capture-pane trims trailing ASCII space, NBSP survives — handler's USER_RE matches either
      logEvent("escape:idle");
      continue;
    }
    turn += 1;
    await runOneTurn(turn, next.text);
    if (CRASH_AFTER > 0 && turn >= CRASH_AFTER) {
      logEvent("crash", { turn });
      process.exit(7);
    }
  }
}

main().catch((err) => {
  logEvent("fatal", { message: err instanceof Error ? err.message : String(err) });
  process.stderr.write(`fake-tui: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(2);
});
