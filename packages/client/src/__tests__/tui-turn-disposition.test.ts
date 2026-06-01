import { describe, expect, it } from "vitest";
import { resolveTurnDisposition } from "../handlers/claude-code-tui/turn-disposition.js";

const CLEAN = { aborted: false, timedOut: false, turnFailed: false, forwardFailed: false };

describe("resolveTurnDisposition", () => {
  it("a clean turn reports success, acks, forwards, and goes idle", () => {
    expect(resolveTurnDisposition(CLEAN)).toEqual({
      status: "success",
      ack: true,
      forward: true,
      runtimeState: "idle",
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
   * is the single source of output), and must surface an error runtime state.
   */
  it("a timed-out turn reports error, does NOT ack, does NOT forward, and surfaces error state", () => {
    expect(resolveTurnDisposition({ ...CLEAN, timedOut: true })).toEqual({
      status: "error",
      ack: false,
      forward: false,
      runtimeState: "error",
    });
  });

  it("a body failure reports error, acks + forwards (clean close, avoid storm), and surfaces error state", () => {
    expect(resolveTurnDisposition({ ...CLEAN, turnFailed: true })).toEqual({
      status: "error",
      ack: true,
      forward: true,
      runtimeState: "error",
    });
  });

  it("a forward-only failure reports error and acks but keeps the session idle", () => {
    expect(resolveTurnDisposition({ ...CLEAN, forwardFailed: true })).toEqual({
      status: "error",
      ack: true,
      forward: true,
      runtimeState: "idle",
    });
  });

  it("an aborted (suspended) turn does NOT ack or forward so it re-runs cleanly on resume", () => {
    expect(resolveTurnDisposition({ ...CLEAN, aborted: true })).toEqual({
      status: "success",
      ack: false,
      forward: false,
      runtimeState: "idle",
    });
  });

  it("timeout dominates: a timed-out turn that also failed to forward still withholds ack + forward", () => {
    expect(resolveTurnDisposition({ ...CLEAN, timedOut: true, forwardFailed: true })).toEqual({
      status: "error",
      ack: false,
      forward: false,
      runtimeState: "error",
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
