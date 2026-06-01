import { describe, expect, it } from "vitest";
import { resolveTurnDisposition } from "../handlers/claude-code-tui/turn-disposition.js";

const CLEAN = { aborted: false, timedOut: false, turnFailed: false, forwardFailed: false };

describe("resolveTurnDisposition", () => {
  it("a clean turn reports success, acks, and goes idle", () => {
    expect(resolveTurnDisposition(CLEAN)).toEqual({ status: "success", ack: true, runtimeState: "idle" });
  });

  /**
   * Regression for PR #712 review round 3: a turn that hit TURN_TIMEOUT_MS was
   * being reported as `success` and acked, silently consuming the user's
   * message with no replay path. A timeout must report error, must NOT ack
   * (so the inbox entries are redelivered for a real retry), and must surface
   * an error runtime state.
   */
  it("a timed-out turn reports error, does NOT ack, and surfaces error state", () => {
    expect(resolveTurnDisposition({ ...CLEAN, timedOut: true })).toEqual({
      status: "error",
      ack: false,
      runtimeState: "error",
    });
  });

  it("a body failure reports error, acks (clean close, avoid storm), and surfaces error state", () => {
    expect(resolveTurnDisposition({ ...CLEAN, turnFailed: true })).toEqual({
      status: "error",
      ack: true,
      runtimeState: "error",
    });
  });

  it("a forward-only failure reports error and acks but keeps the session idle", () => {
    expect(resolveTurnDisposition({ ...CLEAN, forwardFailed: true })).toEqual({
      status: "error",
      ack: true,
      runtimeState: "idle",
    });
  });

  it("an aborted (suspended) turn does NOT ack so it re-runs on resume, and is not flagged failed", () => {
    expect(resolveTurnDisposition({ ...CLEAN, aborted: true })).toEqual({
      status: "success",
      ack: false,
      runtimeState: "idle",
    });
  });

  it("timeout dominates: a timed-out turn that also failed to forward still withholds the ack", () => {
    expect(resolveTurnDisposition({ ...CLEAN, timedOut: true, forwardFailed: true })).toEqual({
      status: "error",
      ack: false,
      runtimeState: "error",
    });
  });
});
