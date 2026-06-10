import { describe, expect, it } from "vitest";
import { resolveTurnDisposition } from "../handlers/claude-code-tui/turn-disposition.js";

const CLEAN = { aborted: false, timedOut: false, turnFailed: false, forwardFailed: false };

describe("resolveTurnDisposition", () => {
  it("a clean turn reports success, acks, forwards, and has no terminal marker", () => {
    expect(resolveTurnDisposition(CLEAN)).toEqual({
      status: "success",
      ack: true,
      forward: true,
      terminalRuntimeError: false,
    });
  });

  /**
   * Regression for PR #712 review round 3 + 4: a turn that hit TURN_TIMEOUT_MS
   * was reported as `success` and acked, silently consuming the user's message
   * with no replay path (round 3). Round 4: even after that fix, a timed-out
   * turn that had drained partial finalText still forwarded it to chat before
   * the no-ack decision — so the chat got a partial message while the entry
   * stayed un-acked and re-ran on reconnect, double-posting. A timeout must
   * report error, must NOT ack AND must NOT forward (so the redelivered retry
   * is the single source of output), and must surface a terminal error marker.
   */
  it("a timed-out turn reports error, does NOT ack, does NOT forward, and surfaces terminal error", () => {
    expect(resolveTurnDisposition({ ...CLEAN, timedOut: true })).toEqual({
      status: "error",
      ack: false,
      forward: false,
      terminalRuntimeError: true,
    });
  });

  it("a body failure reports error, acks + forwards (clean close, avoid storm), and surfaces terminal error", () => {
    expect(resolveTurnDisposition({ ...CLEAN, turnFailed: true })).toEqual({
      status: "error",
      ack: true,
      forward: true,
      terminalRuntimeError: true,
    });
  });

  it("a forward-only failure reports error and acks without a terminal marker", () => {
    expect(resolveTurnDisposition({ ...CLEAN, forwardFailed: true })).toEqual({
      status: "error",
      ack: true,
      forward: true,
      terminalRuntimeError: false,
    });
  });

  it("an aborted (suspended) turn does NOT ack or forward so it re-runs cleanly on resume", () => {
    expect(resolveTurnDisposition({ ...CLEAN, aborted: true })).toEqual({
      status: "success",
      ack: false,
      forward: false,
      terminalRuntimeError: false,
    });
  });

  it("timeout dominates: a timed-out turn that also failed to forward still withholds ack + forward", () => {
    expect(resolveTurnDisposition({ ...CLEAN, timedOut: true, forwardFailed: true })).toEqual({
      status: "error",
      ack: false,
      forward: false,
      terminalRuntimeError: true,
    });
  });

  it("ack and forward always agree (we never consume a turn we won't deliver, or vice versa)", () => {
    for (const aborted of [false, true]) {
      for (const timedOut of [false, true]) {
        for (const turnFailed of [false, true]) {
          for (const forwardFailed of [false, true]) {
            const d = resolveTurnDisposition({ aborted, timedOut, turnFailed, forwardFailed });
            expect(d.ack).toBe(d.forward);
          }
        }
      }
    }
  });
});
