import { createLogger, SdkError } from "@first-tree/client";
import { contextTreeActiveBindingSchema, contextTreeInfoSchema } from "@first-tree/shared";
import { AuthRefreshFailedError } from "./bootstrap.js";
import { classifyCliTransportError } from "./transport-error.js";

export type ContextTreeBindingResult =
  | { status: "bound"; repo: string; branch: string }
  | { status: "unbound"; repo: null; branch: null };

export type ContextTreeUnreadableCategory =
  | "authentication"
  | "connection"
  | "timeout"
  | "remote"
  | "invalid-response"
  | "unknown";

export type ContextTreeConfigReader = {
  readonly agentId?: string;
  getAgentContextTreeConfig(): Promise<unknown>;
};

export type ContextTreeReadLogger = {
  debug(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
};

export type ReadContextTreeBindingOptions = {
  /** Human-readable name when the caller already resolved one. The SDK's agent UUID is the fallback. */
  agent?: string;
  logger?: ContextTreeReadLogger;
};

type ContextTreeUnreadableOptions = {
  category: ContextTreeUnreadableCategory;
  exitCode: 1 | 3 | 6;
  httpStatus?: number;
};

export class ContextTreeUnreadableError extends Error {
  readonly code = "CONTEXT_TREE_UNREADABLE";
  readonly status = "unreadable";
  readonly category: ContextTreeUnreadableCategory;
  readonly exitCode: 1 | 3 | 6;
  readonly httpStatus?: number;

  constructor(message: string, options: ContextTreeUnreadableOptions) {
    super(message);
    this.name = "ContextTreeUnreadableError";
    this.category = options.category;
    this.exitCode = options.exitCode;
    this.httpStatus = options.httpStatus;
  }
}

/**
 * Validate and normalize the agent-scoped Context Tree wire response.
 *
 * `repo` alone determines bound state. This deliberately ignores a default
 * branch on an unbound response and supplies `main` only for a bound response
 * whose branch is null.
 */
export function normalizeContextTreeBinding(response: unknown): ContextTreeBindingResult {
  const parsed = contextTreeInfoSchema.safeParse(response);
  if (!parsed.success) {
    throw invalidResponseError();
  }

  if (parsed.data.repo === null) {
    return { status: "unbound", repo: null, branch: null };
  }

  const binding = contextTreeActiveBindingSchema.safeParse(parsed.data);
  if (!binding.success) {
    throw invalidResponseError();
  }

  return {
    status: "bound",
    repo: binding.data.repo,
    branch: binding.data.branch,
  };
}

/** Read the binding through the SDK's agent-scoped endpoint and fail closed. */
export async function readAgentContextTreeBinding(
  sdk: ContextTreeConfigReader,
  options: ReadContextTreeBindingOptions = {},
): Promise<ContextTreeBindingResult> {
  // The CLI applies --json/--verbose logging in its preAction hook. Create the
  // child here so it inherits that invocation's final level.
  const outputLogger = options.logger ?? createLogger("context-tree-binding");
  const agent = options.agent ?? sdk.agentId ?? null;
  outputLogger.debug({ agent }, "reading agent Context Tree binding");

  try {
    const response = await sdk.getAgentContextTreeConfig();
    const binding = normalizeContextTreeBinding(response);
    outputLogger.debug({ agent, status: binding.status }, "normalized agent Context Tree binding");
    return binding;
  } catch (error) {
    const unreadable = classifyContextTreeReadError(error);
    outputLogger.warn(
      {
        agent,
        category: unreadable.category,
        exitCode: unreadable.exitCode,
        ...(unreadable.httpStatus === undefined ? {} : { httpStatus: unreadable.httpStatus }),
      },
      "agent Context Tree binding is unreadable",
    );
    throw unreadable;
  }
}

/** Map transport, auth, remote, and validation failures to the CLI contract. */
export function classifyContextTreeReadError(error: unknown): ContextTreeUnreadableError {
  if (error instanceof ContextTreeUnreadableError) {
    return error;
  }

  const sdkStatus = error instanceof SdkError ? error.statusCode : readNumberProperty(error, "statusCode");
  if (sdkStatus !== undefined) {
    if (sdkStatus === 401) {
      return new ContextTreeUnreadableError(
        "Authentication failed while reading the Context Tree binding (HTTP 401). Sign in again and retry.",
        { category: "authentication", exitCode: 3, httpStatus: sdkStatus },
      );
    }
    return new ContextTreeUnreadableError(`The server could not return the Context Tree binding (HTTP ${sdkStatus}).`, {
      category: "remote",
      exitCode: 1,
      httpStatus: sdkStatus,
    });
  }

  // Response parsing/validation failures remain invalid responses even when
  // their parser-generated message happens to contain transport/auth words.
  if (error instanceof SyntaxError) {
    return invalidResponseError();
  }

  if (readStringProperty(error, "name") === "ZodError" || Array.isArray(readProperty(error, "issues"))) {
    return invalidResponseError();
  }

  if (error instanceof AuthRefreshFailedError || readStringProperty(error, "name") === "AuthRefreshFailedError") {
    return new ContextTreeUnreadableError(
      "Authentication expired while reading the Context Tree binding. Sign in again and retry.",
      { category: "authentication", exitCode: 3 },
    );
  }

  // Missing/invalid local credentials are authentication failures too. Keep
  // the message generic so credential details never enter the envelope.
  const errorMessage = readStringProperty(error, "message")?.toLowerCase() ?? "";
  if (
    errorMessage.includes("no credentials found") ||
    errorMessage.includes("authentication required") ||
    errorMessage.includes("authentication failed") ||
    errorMessage.includes("authentication expired")
  ) {
    return new ContextTreeUnreadableError(
      "Authentication is required to read the Context Tree binding. Sign in and retry.",
      { category: "authentication", exitCode: 3 },
    );
  }

  const transportCategory = classifyCliTransportError(error);
  if (transportCategory === "timeout") {
    return new ContextTreeUnreadableError("Timed out while reading the Context Tree binding.", {
      category: "timeout",
      exitCode: 6,
    });
  }
  if (transportCategory === "connection") {
    return new ContextTreeUnreadableError("Could not connect to the server while reading the Context Tree binding.", {
      category: "connection",
      exitCode: 6,
    });
  }

  return new ContextTreeUnreadableError("Could not read the Context Tree binding.", {
    category: "unknown",
    exitCode: 1,
  });
}

function invalidResponseError(): ContextTreeUnreadableError {
  return new ContextTreeUnreadableError("The server returned an invalid Context Tree binding response.", {
    category: "invalid-response",
    exitCode: 1,
  });
}

function readProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  return Reflect.get(value, property);
}

function readStringProperty(value: unknown, property: string): string | undefined {
  const result = readProperty(value, property);
  return typeof result === "string" ? result : undefined;
}

function readNumberProperty(value: unknown, property: string): number | undefined {
  const result = readProperty(value, property);
  return typeof result === "number" && Number.isFinite(result) ? result : undefined;
}
