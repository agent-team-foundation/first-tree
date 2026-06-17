import type { TurnConsumedErrorReason, TurnOutcome } from "../runtime/handler.js";

export type TurnSettlementStatus = "success" | "error";

export type TurnSettlementAction = { kind: "complete"; outcome: TurnOutcome } | { kind: "retry"; reason: string };

export type TurnSettlement = {
  status: TurnSettlementStatus;
  forward: boolean;
  ack: boolean;
  action: TurnSettlementAction;
};

export type TurnSettlementInput = {
  retryReason?: string | null;
  retryStatus?: TurnSettlementStatus;
  consumedErrorReason?: TurnConsumedErrorReason | null;
  forwardFailed?: boolean;
};

export type TuiTurnSettlementInput = {
  aborted: boolean;
  timedOut: boolean;
  turnFailed: boolean;
  forwardFailed: boolean;
};

export function consumedErrorOutcome(reason: TurnConsumedErrorReason): TurnOutcome {
  return {
    status: "error",
    terminal: true,
    completion: "consumed",
    reason,
  };
}

export function resolveTurnSettlement(input: TurnSettlementInput): TurnSettlement {
  if (input.retryReason) {
    return {
      status: input.retryStatus ?? "error",
      forward: false,
      ack: false,
      action: { kind: "retry", reason: input.retryReason },
    };
  }

  if (input.forwardFailed) {
    return {
      status: "error",
      forward: true,
      ack: true,
      action: { kind: "complete", outcome: consumedErrorOutcome("forward_failed") },
    };
  }

  if (input.consumedErrorReason) {
    return {
      status: "error",
      forward: true,
      ack: true,
      action: { kind: "complete", outcome: consumedErrorOutcome(input.consumedErrorReason) },
    };
  }

  return {
    status: "success",
    forward: true,
    ack: true,
    action: { kind: "complete", outcome: { status: "success", terminal: true } },
  };
}

export function resolveTuiTurnSettlement(input: TuiTurnSettlementInput): TurnSettlement {
  const retryReason = input.timedOut ? "turn_timeout" : input.aborted ? "turn_aborted" : null;
  return resolveTurnSettlement({
    retryReason,
    retryStatus: input.aborted && !input.timedOut ? "success" : "error",
    consumedErrorReason: input.turnFailed ? "provider_clean_error" : null,
    forwardFailed: input.forwardFailed,
  });
}
