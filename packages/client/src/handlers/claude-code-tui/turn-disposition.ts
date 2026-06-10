/**
 * How a single TUI turn ended. The boolean flags are mutually compatible
 * (e.g. a turn can both time out and have a forward failure); the disposition
 * resolves them into the three observable outcomes the runtime cares about.
 */
export type TurnOutcome = {
  /** suspend()/shutdown() aborted the turn — it must re-run on resume. */
  aborted: boolean;
  /**
   * The poll loop hit TURN_TIMEOUT_MS without claude reaching idle and without
   * an explicit abort — claude was interrupted mid-flight, so the turn's
   * outcome is unknown.
   */
  timedOut: boolean;
  /** The runTurn body threw (e.g. the tmux session died). */
  turnFailed: boolean;
  /** forwardResult threw while delivering the assistant text. */
  forwardFailed: boolean;
};

export type TurnDisposition = {
  /** Status reported on the `turn_end` event. */
  status: "success" | "error";
  /**
   * Whether to `finishTurn` (ack the triggering inbox entries). The runtime
   * never auto-acks on turn_end, so a false here leaves the entries in-flight
   * for at-least-once redelivery.
   */
  ack: boolean;
  /**
   * Whether to deliver the assistant text to chat (`forwardResult`). Tracks
   * `ack`: we only post output for a turn we are consuming. A turn that will
   * re-run (abort/timeout) must NOT forward partial output, or the chat
   * double-posts once the replay produces the real answer.
   */
  forward: boolean;
  /** Whether SessionManager should retain a fatal runtime error marker. */
  terminalRuntimeError: boolean;
};

/**
 * Resolve how a finished turn is reported and acked.
 *
 * The reliability-critical rule (PR #712 review round 3): a **timed-out** turn
 * is NOT a success. claude was interrupted before reaching idle, so we cannot
 * confirm the work completed. Acking it would silently consume the user's
 * message with no replay path — exactly the bug this function guards. So a
 * timeout reports `turn_end: error`, leaves the inbox entries un-acked (the
 * server redelivers them on reconnect/restart for a genuine retry), and surfaces
 * an `error` runtime state.
 *
 * Ack policy otherwise mirrors the SDK handler's `ackTurnClose`: a clean close
 * acks even on a plain forward failure (claude finished; re-running yields the
 * same result, so acking avoids a redelivery storm). Only `aborted` (suspend)
 * and `timedOut` withhold the ack.
 *
 * `aborted` keeps the pre-existing semantics: it is a deliberate suspend, not a
 * failure, so it does not flip the status to error on its own — it only
 * withholds the ack so the message re-runs on resume.
 */
export function resolveTurnDisposition(outcome: TurnOutcome): TurnDisposition {
  const { aborted, timedOut, turnFailed, forwardFailed } = outcome;
  // Consume the turn (ack + deliver its output) only when it is NOT going to
  // re-run. abort (suspend) and timeout both leave the entries un-acked for a
  // replay, so neither acks nor forwards — otherwise the replay double-posts.
  const consume = !aborted && !timedOut;
  return {
    status: turnFailed || forwardFailed || timedOut ? "error" : "success",
    ack: consume,
    forward: consume,
    // A broken (turnFailed) or interrupted (timedOut) session is advertised as
    // error; a forward-only failure leaves the session healthy.
    terminalRuntimeError: turnFailed || timedOut,
  };
}
