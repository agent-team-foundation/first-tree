import { contextTreeActiveBindingSchema } from "@first-tree/shared";
import { classifyContextTreeReadError } from "../context-tree-binding.js";
import { ContextRootScopeError, fetchExactScope } from "./exact-root-scope.js";

export type ContextEnableScopePreflightErrorCode =
  | "CONTEXT_ENABLE_SCOPE_AUTHENTICATION_REQUIRED"
  | "CONTEXT_ENABLE_BINDING_UNREADABLE"
  | "CONTEXT_ENABLE_SCOPE_MISSING"
  | "CONTEXT_ENABLE_SCOPE_INVALID"
  | "CONTEXT_ENABLE_SCOPE_FETCH_FAILED";

export type ContextEnableScopePreflightStage = "authority" | "binding" | "scope" | "fetch";

export type ContextEnableScopePreflightReader = {
  getMemberContextTreeSetting(teamId: string, options: { retry: false }): Promise<unknown>;
};

type ContextEnableScopePreflightErrorOptions = {
  stage: ContextEnableScopePreflightStage;
  exitCode: 1 | 3 | 6;
  httpStatus?: number;
  cause?: unknown;
};

export class ContextEnableScopePreflightError extends Error {
  readonly stage: ContextEnableScopePreflightStage;
  readonly exitCode: 1 | 3 | 6;
  readonly httpStatus?: number;

  constructor(
    readonly code: ContextEnableScopePreflightErrorCode,
    message: string,
    options: ContextEnableScopePreflightErrorOptions,
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ContextEnableScopePreflightError";
    this.stage = options.stage;
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
  }
}

/** Verify the selected Team's minimum root-SCOPE routing preconditions without mutation. */
export async function preflightContextEnableScope(
  reader: ContextEnableScopePreflightReader,
  teamId: string,
): Promise<void> {
  let rawBinding: unknown;
  try {
    rawBinding = await reader.getMemberContextTreeSetting(teamId, { retry: false });
  } catch (error) {
    throw bindingReadFailure(error);
  }

  const binding = contextTreeActiveBindingSchema.safeParse(rawBinding);
  if (!binding.success) {
    throw new ContextEnableScopePreflightError(
      "CONTEXT_ENABLE_BINDING_UNREADABLE",
      "The selected Team does not have a readable current Context Tree binding. Repair the binding before retrying.",
      { stage: "binding", exitCode: 1, cause: binding.error },
    );
  }

  try {
    fetchExactScope(binding.data);
  } catch (error) {
    throw rootScopeFailure(error);
  }
}

function bindingReadFailure(error: unknown): ContextEnableScopePreflightError {
  const classified = classifyContextTreeReadError(error);
  if (classified.category === "authentication") {
    return new ContextEnableScopePreflightError(
      "CONTEXT_ENABLE_SCOPE_AUTHENTICATION_REQUIRED",
      "Authentication failed while checking the selected Team's Context Tree readiness. Sign in again and retry.",
      {
        stage: "authority",
        exitCode: 3,
        ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
        cause: error,
      },
    );
  }
  return new ContextEnableScopePreflightError(
    "CONTEXT_ENABLE_BINDING_UNREADABLE",
    "The selected Team's current Context Tree binding could not be read online. Confirm active membership and repair the binding before retrying.",
    {
      stage: "binding",
      exitCode: classified.exitCode,
      ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
      cause: error,
    },
  );
}

function rootScopeFailure(error: unknown): ContextEnableScopePreflightError {
  if (error instanceof ContextRootScopeError) {
    if (error.kind === "missing") {
      return new ContextEnableScopePreflightError(
        "CONTEXT_ENABLE_SCOPE_MISSING",
        "The selected Team's binding branch must contain root SCOPE.md as a regular file before Context setup can continue.",
        { stage: "scope", exitCode: 1, cause: error },
      );
    }
    if (error.kind === "invalid") {
      return new ContextEnableScopePreflightError(
        "CONTEXT_ENABLE_SCOPE_INVALID",
        "The selected Team's root SCOPE.md must be valid UTF-8 and satisfy SCOPE schema version 1. Repair it and retry Context setup.",
        { stage: "scope", exitCode: 1, cause: error },
      );
    }
  }
  return new ContextEnableScopePreflightError(
    "CONTEXT_ENABLE_SCOPE_FETCH_FAILED",
    "Could not fetch root SCOPE.md from the selected Team's current binding. Confirm repository access, network connectivity, and the bound branch, then retry.",
    { stage: "fetch", exitCode: 6, cause: error },
  );
}
