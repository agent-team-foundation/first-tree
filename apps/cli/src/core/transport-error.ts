const CONNECTION_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export type CliTransportErrorCategory = "connection" | "timeout";

/**
 * Classify Node/undici transport failures without exposing their messages.
 *
 * Keep this as the CLI's single transport taxonomy for Context bootstrap and
 * authority paths. The cause walk handles undici's `TypeError("fetch
 * failed").cause` shape while the explicit code set also covers bare DNS/TCP
 * errors that have no outer fetch message.
 */
export function classifyCliTransportError(error: unknown): CliTransportErrorCategory | null {
  let current: unknown = error;
  let sawConnectionError = false;

  for (let depth = 0; depth < 6 && current !== undefined && current !== null; depth++) {
    const name = readStringProperty(current, "name");
    const code = readStringProperty(current, "code");
    const message = readStringProperty(current, "message");
    const normalizedMessage = message?.toLowerCase();

    if (
      name === "AbortError" ||
      name === "TimeoutError" ||
      code === "ERR_ABORTED" ||
      code?.includes("TIMEOUT") ||
      normalizedMessage?.includes("timed out") ||
      normalizedMessage?.includes("timeout")
    ) {
      return "timeout";
    }
    if (code && CONNECTION_ERROR_CODES.has(code)) {
      if (code === "ECONNABORTED" || code === "ETIMEDOUT") return "timeout";
      sawConnectionError = true;
    }
    if (normalizedMessage?.includes("fetch failed")) {
      sawConnectionError = true;
    }
    if (current instanceof TypeError && hasProperty(current, "cause")) {
      sawConnectionError = true;
    }

    current = readProperty(current, "cause");
  }

  return sawConnectionError ? "connection" : null;
}

function hasProperty(value: unknown, property: string): boolean {
  return (typeof value === "object" && value !== null) || typeof value === "function"
    ? Reflect.has(value, property)
    : false;
}

function readProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  return Reflect.get(value, property);
}

function readStringProperty(value: unknown, property: string): string | undefined {
  const result = readProperty(value, property);
  return typeof result === "string" ? result : undefined;
}
