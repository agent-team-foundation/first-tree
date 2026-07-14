import { createLogger } from "@first-tree/client";
import { contextTreeBranchSchema, contextTreeInfoSchema, contextTreeRepoSchema } from "@first-tree/shared";
import {
  type ContextTreeBindingResult,
  type ContextTreeConfigReader,
  type ContextTreeReadLogger,
  type ContextTreeUnreadableCategory,
  classifyContextTreeReadError,
  normalizeContextTreeBinding,
} from "./context-tree-binding.js";

export type ContextTreeBindingInput = {
  repo: string;
  branch?: string;
};

export type ContextTreeConfigWriter = Pick<ContextTreeConfigReader, "agentId"> & {
  setAgentContextTreeConfig(input: ContextTreeBindingInput): Promise<unknown>;
};

export type ContextTreeUpdateFailedCategory = ContextTreeUnreadableCategory;

export type SetContextTreeBindingOptions = {
  /** Human-readable name when the caller already resolved one. The SDK's agent UUID is the fallback. */
  agent?: string;
  logger?: ContextTreeReadLogger;
};

type ContextTreeUpdateFailedOptions = {
  category: ContextTreeUpdateFailedCategory;
  exitCode: 1 | 3 | 6;
  httpStatus?: number;
};

export class InvalidContextTreeBindingInputError extends Error {
  readonly exitCode = 2;

  constructor(
    readonly code: "INVALID_CONTEXT_TREE_REPO" | "INVALID_CONTEXT_TREE_BRANCH",
    message: string,
  ) {
    super(message);
    this.name = "InvalidContextTreeBindingInputError";
  }
}

export class ContextTreeUpdateFailedError extends Error {
  readonly code = "CONTEXT_TREE_UPDATE_FAILED";
  readonly category: ContextTreeUpdateFailedCategory;
  readonly exitCode: 1 | 3 | 6;
  readonly httpStatus?: number;

  constructor(message: string, options: ContextTreeUpdateFailedOptions) {
    super(message);
    this.name = "ContextTreeUpdateFailedError";
    this.category = options.category;
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
  }
}

/** Validate without trimming so request/response equality remains exact. */
export function validateContextTreeBindingInput(input: { repo: unknown; branch?: unknown }): ContextTreeBindingInput {
  const repo = contextTreeRepoSchema.safeParse(input.repo);
  if (!repo.success) {
    throw new InvalidContextTreeBindingInputError(
      "INVALID_CONTEXT_TREE_REPO",
      "Repository must be an HTTPS, ssh://, or scp-like SSH URL with a host and repository path, without embedded credentials, surrounding whitespace, or control characters.",
    );
  }

  if (input.branch === undefined) return { repo: repo.data };

  const branch = contextTreeBranchSchema.safeParse(input.branch);
  if (!branch.success) {
    throw new InvalidContextTreeBindingInputError(
      "INVALID_CONTEXT_TREE_BRANCH",
      "Branch must be a non-empty single-line value without surrounding whitespace or control characters.",
    );
  }

  return { repo: repo.data, branch: branch.data };
}

/** Update the selected agent organization's binding and fail closed on an inconsistent response. */
export async function setAgentContextTreeBinding(
  sdk: ContextTreeConfigWriter,
  rawInput: ContextTreeBindingInput,
  options: SetContextTreeBindingOptions = {},
): Promise<Extract<ContextTreeBindingResult, { status: "bound" }>> {
  const input = validateContextTreeBindingInput(rawInput);
  const agent = options.agent ?? sdk.agentId ?? null;
  // Logger construction stays inside the call so the CLI preAction hook can
  // apply --json/--verbose before the child inherits its effective level.
  const logger = options.logger ?? createLogger("context-tree-binding");
  logger.debug({ agent, phase: "update" }, "updating agent organization Context Tree binding");

  try {
    const response = await sdk.setAgentContextTreeConfig(input);
    const parsedResponse = contextTreeInfoSchema.safeParse(response);
    if (!parsedResponse.success || (input.branch !== undefined && parsedResponse.data.branch !== input.branch)) {
      throw invalidUpdateResponseError();
    }
    const binding = normalizeContextTreeBinding(parsedResponse.data);
    if (binding.status !== "bound" || binding.repo !== input.repo) {
      throw invalidUpdateResponseError();
    }

    logger.debug({ agent, status: binding.status }, "updated agent organization Context Tree binding");
    return binding;
  } catch (error) {
    const failed = classifyContextTreeUpdateError(error);
    logger.warn(
      {
        category: failed.category,
        exitCode: failed.exitCode,
        ...(failed.httpStatus === undefined ? {} : { httpStatus: failed.httpStatus }),
      },
      "agent organization Context Tree binding update failed",
    );
    throw failed;
  }
}

/** Preserve the read command's proven auth/transport taxonomy with write-specific messages. */
export function classifyContextTreeUpdateError(error: unknown): ContextTreeUpdateFailedError {
  if (error instanceof ContextTreeUpdateFailedError) return error;

  const classified = classifyContextTreeReadError(error);
  const options: ContextTreeUpdateFailedOptions = {
    category: classified.category,
    exitCode: classified.exitCode,
    ...(classified.httpStatus === undefined ? {} : { httpStatus: classified.httpStatus }),
  };

  if (classified.category === "authentication") {
    return new ContextTreeUpdateFailedError(
      "Authentication failed while updating the Context Tree binding. Sign in again and retry.",
      options,
    );
  }
  if (classified.category === "timeout") {
    return new ContextTreeUpdateFailedError(
      `Timed out while updating the Context Tree binding. ${confirmationGuidance()}`,
      options,
    );
  }
  if (classified.category === "connection") {
    return new ContextTreeUpdateFailedError(
      `Could not connect to the server while updating the Context Tree binding. ${confirmationGuidance()}`,
      options,
    );
  }
  if (classified.category === "invalid-response") {
    return new ContextTreeUpdateFailedError(
      `The server returned an invalid Context Tree update response. ${confirmationGuidance()}`,
      options,
    );
  }
  if (classified.httpStatus === 403) {
    return new ContextTreeUpdateFailedError(
      "The server rejected the Context Tree binding update (HTTP 403). Administrator access to the selected agent's organization is required.",
      options,
    );
  }
  if (classified.httpStatus !== undefined) {
    const guidance = classified.httpStatus >= 500 ? ` ${confirmationGuidance()}` : "";
    return new ContextTreeUpdateFailedError(
      `The server could not update the Context Tree binding (HTTP ${classified.httpStatus}).${guidance}`,
      options,
    );
  }

  return new ContextTreeUpdateFailedError(
    `Could not update the Context Tree binding. ${confirmationGuidance()}`,
    options,
  );
}

function invalidUpdateResponseError(): ContextTreeUpdateFailedError {
  return new ContextTreeUpdateFailedError(
    `The server returned an inconsistent Context Tree update response. ${confirmationGuidance()}`,
    { category: "invalid-response", exitCode: 1 },
  );
}

function confirmationGuidance(): string {
  return "Run `first-tree org context-tree` with the same agent selection to confirm the current binding before retrying.";
}
