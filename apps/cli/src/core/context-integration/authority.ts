import type { ContextActivationResponse } from "@first-tree/shared";
import { classifyCliTransportError } from "../transport-error.js";

export type ContextActivationValidator = {
  validateMemberContextActivation(
    organizationId: string,
    data: {
      schemaVersion: 1;
      repositoryKey: string;
    },
    options: { retry: false; timeoutMs: number },
  ): Promise<ContextActivationResponse>;
};

export type ExternalContextAuthorityMode = "session-start" | "explicit";

export type ExternalContextAuthorityUnavailable = {
  outcome: "unavailable";
  reasonCode:
    | "authority_authentication_required"
    | "authority_forbidden"
    | "authority_network_error"
    | "authority_request_rejected"
    | "authority_server_error"
    | "authority_timeout"
    | "authority_unavailable";
  systemMessage: string;
};

export type ExternalContextAuthorityResult =
  | {
      outcome: "validated";
      response: ContextActivationResponse;
    }
  | ExternalContextAuthorityUnavailable;

const AUTHORITY_POLICIES: Record<
  ExternalContextAuthorityMode,
  {
    attempts: 1 | 2;
    timeoutMs: number;
  }
> = {
  "session-start": {
    attempts: 1,
    timeoutMs: 2_000,
  },
  explicit: {
    attempts: 2,
    timeoutMs: 5_000,
  },
};

/**
 * Perform one logical live-authority check.
 *
 * SessionStart stays latency-bounded and never retries. Explicit user/Skill
 * operations get one retry against the same exact Team + repository only for
 * transport timeouts, network failures, and HTTP 5xx responses.
 */
export async function validateExternalContextAuthority(
  validator: ContextActivationValidator,
  organizationId: string,
  repositoryKey: string,
  mode: ExternalContextAuthorityMode,
): Promise<ExternalContextAuthorityResult> {
  const policy = AUTHORITY_POLICIES[mode];
  let failure: ClassifiedAuthorityFailure | undefined;
  for (let attempt = 0; attempt < policy.attempts; attempt++) {
    try {
      const response = await validator.validateMemberContextActivation(
        organizationId,
        {
          schemaVersion: 1,
          repositoryKey,
        },
        { retry: false, timeoutMs: policy.timeoutMs },
      );
      return {
        outcome: "validated",
        response,
      };
    } catch (error) {
      failure = classifyAuthorityFailure(error);
      if (!failure.retryable) break;
    }
  }
  return (failure ?? classifyAuthorityFailure(undefined)).result;
}

type ClassifiedAuthorityFailure = {
  result: ExternalContextAuthorityUnavailable;
  retryable: boolean;
};

function classifyAuthorityFailure(error: unknown): ClassifiedAuthorityFailure {
  const statusCode = errorNumberField(error, "statusCode");
  const errorName = errorStringField(error, "name");
  if (statusCode === 401 || errorName === "AuthRefreshFailedError") {
    return terminalFailure(
      "authority_authentication_required",
      "First Tree Context authority requires a fresh First Tree login. No cached Team authority was used.",
    );
  }
  if (statusCode === 403) {
    return terminalFailure(
      "authority_forbidden",
      "First Tree Context authority was denied for the bound Team. No cached Team authority was used.",
    );
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return transientFailure(
      "authority_server_error",
      "First Tree Context authority service returned a temporary server error. Normal coding can continue; no cached Team authority was used.",
    );
  }
  if ((statusCode !== undefined && statusCode >= 400) || errorName === "AuthRefreshRateLimitedError") {
    return terminalFailure(
      "authority_request_rejected",
      "First Tree Context authority request was rejected. No cached Team authority was used.",
    );
  }

  const transportCategory = classifyCliTransportError(error);
  if (transportCategory === "timeout") {
    return transientFailure(
      "authority_timeout",
      "First Tree Context authority check timed out. Normal coding can continue; no cached Team authority was used.",
    );
  }
  if (transportCategory === "connection") {
    return transientFailure(
      "authority_network_error",
      "First Tree Context authority service could not be reached. Normal coding can continue; no cached Team authority was used.",
    );
  }
  return terminalFailure(
    "authority_unavailable",
    "First Tree Context is temporarily unavailable. Normal coding can continue; no cached Team authority was used.",
  );
}

function transientFailure(
  reasonCode: ExternalContextAuthorityUnavailable["reasonCode"],
  systemMessage: string,
): ClassifiedAuthorityFailure {
  return {
    retryable: true,
    result: {
      outcome: "unavailable",
      reasonCode,
      systemMessage,
    },
  };
}

function terminalFailure(
  reasonCode: ExternalContextAuthorityUnavailable["reasonCode"],
  systemMessage: string,
): ClassifiedAuthorityFailure {
  return {
    retryable: false,
    result: {
      outcome: "unavailable",
      reasonCode,
      systemMessage,
    },
  };
}

function errorNumberField(error: unknown, field: string): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = Reflect.get(error, field);
  return typeof value === "number" ? value : undefined;
}

function errorStringField(error: unknown, field: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = Reflect.get(error, field);
  return typeof value === "string" ? value : undefined;
}
