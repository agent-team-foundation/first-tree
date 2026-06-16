import { describe, expect, it } from "vitest";
import { resolveTuiTurnSettlement } from "../handlers/turn-settlement.js";

const CLEAN = { aborted: false, timedOut: false, turnFailed: false, forwardFailed: false };

describe("resolveTuiTurnSettlement", () => {
  it("a clean turn reports success, acks, and forwards", () => {
    expect(resolveTuiTurnSettlement(CLEAN)).toEqual({
      status: "success",
      ack: true,
      forward: true,
      action: { kind: "complete", outcome: { status: "success", terminal: true } },
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
   * is the single source of output).
   */
  it("a timed-out turn reports error and does NOT ack or forward", () => {
    expect(resolveTuiTurnSettlement({ ...CLEAN, timedOut: true })).toEqual({
      status: "error",
      ack: false,
      forward: false,
      action: { kind: "retry", reason: "turn_timeout" },
    });
  });

  it("a body failure reports error, acks, and forwards (clean close, avoid storm)", () => {
    expect(resolveTuiTurnSettlement({ ...CLEAN, turnFailed: true })).toEqual({
      status: "error",
      ack: true,
      forward: true,
      action: {
        kind: "complete",
        outcome: { status: "error", terminal: true, completion: "consumed", reason: "provider_clean_error" },
      },
    });
  });

  it("a forward-only failure reports error but still consumes the turn", () => {
    expect(resolveTuiTurnSettlement({ ...CLEAN, forwardFailed: true })).toEqual({
      status: "error",
      ack: true,
      forward: true,
      action: {
        kind: "complete",
        outcome: { status: "error", terminal: true, completion: "consumed", reason: "forward_failed" },
      },
    });
  });

  it("an aborted (suspended) turn does NOT ack or forward so it re-runs cleanly on resume", () => {
    expect(resolveTuiTurnSettlement({ ...CLEAN, aborted: true })).toEqual({
      status: "success",
      ack: false,
      forward: false,
      action: { kind: "retry", reason: "turn_aborted" },
    });
  });

  it("timeout dominates: a timed-out turn that also failed to forward still withholds ack + forward", () => {
    expect(resolveTuiTurnSettlement({ ...CLEAN, timedOut: true, forwardFailed: true })).toEqual({
      status: "error",
      ack: false,
      forward: false,
      action: { kind: "retry", reason: "turn_timeout" },
    });
  });

  it("ack and forward always agree (we never consume a turn we won't deliver, or vice versa)", () => {
    for (const aborted of [false, true]) {
      for (const timedOut of [false, true]) {
        for (const turnFailed of [false, true]) {
          for (const forwardFailed of [false, true]) {
            const d = resolveTuiTurnSettlement({ aborted, timedOut, turnFailed, forwardFailed });
            expect(d.ack).toBe(d.forward);
            expect(d.ack).toBe(d.action.kind === "complete");
          }
        }
      }
    }
  });
});
