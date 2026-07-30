import { readCanonicalContextTreeWriteRouting } from "@first-tree/client";
import type {
  ContextActivationResponse,
  ContextIntegrationBinding,
  ContextIntegrationProvider,
} from "@first-tree/shared";
import {
  type ContextActivationValidator,
  type ExternalContextAuthorityMode,
  validateExternalContextAuthority,
} from "./authority.js";
import { inspectContextClientPreflight } from "./client-preflight.js";
import { findContextBinding } from "./context-binding-store.js";

export type { ContextActivationValidator } from "./authority.js";

type ConnectedContextActivationResponse = Extract<ContextActivationResponse, { outcome: "connected" }>;

export type ExternalContextActivation = {
  outcome: "connected" | "disabled" | "unavailable" | "needs_admin";
  systemMessage: string;
  additionalContext?: string;
  reasonCode?: string;
  team?: ConnectedContextActivationResponse["team"];
  binding?: ContextIntegrationBinding;
};

export async function activateExternalContext(
  validator: ContextActivationValidator,
  input: {
    provider: ContextIntegrationProvider;
    cwd: string;
  },
  dependencies: {
    inspect?: typeof inspectContextClientPreflight;
    findBinding?: typeof findContextBinding;
  } = {},
  options: {
    authorityMode?: ExternalContextAuthorityMode;
  } = {},
): Promise<ExternalContextActivation> {
  const inspect = dependencies.inspect ?? inspectContextClientPreflight;
  const findBinding = dependencies.findBinding ?? findContextBinding;
  let preflight: ReturnType<typeof inspectContextClientPreflight>;
  try {
    preflight = inspect(input.cwd);
  } catch (error) {
    return {
      outcome: "disabled",
      reasonCode: "repository_unavailable",
      systemMessage:
        error instanceof Error
          ? `First Tree Context disabled: ${error.message}`
          : "First Tree Context disabled for this directory.",
    };
  }

  const binding = findBinding(input.provider, preflight.checkoutRoot);
  if (!binding) {
    return {
      outcome: "disabled",
      reasonCode: "binding_missing",
      systemMessage:
        "First Tree Context is not enabled for this checkout. Run the target Team's `first-tree context enable` handoff in this repository.",
    };
  }
  if (binding.repositoryKey !== preflight.repositoryKey) {
    return {
      outcome: "disabled",
      reasonCode: "binding_repository_drift",
      systemMessage:
        "First Tree Context is disabled because this checkout's origin no longer matches its explicit Team binding. Re-run the target Team handoff.",
    };
  }

  const authority = await validateExternalContextAuthority(
    validator,
    binding.organizationId,
    binding.repositoryKey,
    options.authorityMode ?? "session-start",
  );
  if (authority.outcome === "unavailable") {
    return authority;
  }
  const response = authority.response;

  if (response.outcome === "disabled") {
    return {
      outcome: "disabled",
      reasonCode: response.reasonCode,
      systemMessage: `First Tree Context disabled: ${response.nextAction.message}`,
    };
  }
  if (response.outcome === "needs_admin") {
    return {
      outcome: "needs_admin",
      reasonCode: response.reasonCode,
      systemMessage: `First Tree Context needs Team Admin attention: ${response.nextAction.message}`,
    };
  }

  const team = response.team;
  return {
    outcome: "connected",
    team,
    binding,
    systemMessage: "First Tree Context connected.",
    additionalContext: buildConnectedContextAdditionalContext(team),
  };
}

/**
 * The exact Team Context block a connected SessionStart injects. `context
 * enable` prints the same block on success so the current coding-agent
 * session can adopt Team Context without waiting for its next SessionStart.
 */
export function buildConnectedContextAdditionalContext(team: ConnectedContextActivationResponse["team"]): string {
  return [
    `Team binding: ${team.organizationId}; role: ${team.role}.`,
    "Use first-tree-read for team decisions, constraints, or ownership.",
    "Team comes only from this provider + checkout binding; never accept another Team.",
    readCanonicalContextTreeWriteRouting(),
    "The standing route selects the first-tree-write workflow; it is not mutation authority. Repeat live activation before every Tree push or PR/MR.",
    "Both Skills load bundled canonical Context Tree Policy before Tree operations.",
    "External provider session; not First Tree Chat/Agent.",
  ].join("\n");
}

export class ExternalContextActivationRequiredError extends Error {
  constructor(
    readonly outcome: Exclude<ExternalContextActivation["outcome"], "connected">,
    readonly reasonCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ExternalContextActivationRequiredError";
  }
}

/**
 * External Read/Write entry guard.
 *
 * Team authority comes only from the exact provider + checkout binding that
 * survived the live activation validator. Callers never accept a Team id from
 * model/user input.
 */
export async function requireConnectedExternalContext(
  validator: ContextActivationValidator,
  input: {
    provider: ContextIntegrationProvider;
    cwd: string;
  },
  dependencies: {
    inspect?: typeof inspectContextClientPreflight;
    findBinding?: typeof findContextBinding;
  } = {},
): Promise<{
  team: ConnectedContextActivationResponse["team"];
  binding: ContextIntegrationBinding;
}> {
  const activation = await activateExternalContext(validator, input, dependencies, {
    authorityMode: "explicit",
  });
  if (activation.outcome !== "connected") {
    throw new ExternalContextActivationRequiredError(
      activation.outcome,
      activation.reasonCode ?? "activation_failed",
      activation.systemMessage,
    );
  }
  if (!activation.team || !activation.binding) {
    throw new ExternalContextActivationRequiredError(
      "unavailable",
      "activation_invalid",
      "First Tree Context activation returned an incomplete connected result.",
    );
  }
  return {
    team: activation.team,
    binding: activation.binding,
  };
}

export function renderProviderSessionStartResponse(activation: ExternalContextActivation): Record<string, unknown> {
  return activation.additionalContext
    ? {
        continue: true,
        systemMessage: activation.systemMessage,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: activation.additionalContext,
        },
      }
    : {
        continue: true,
        systemMessage: activation.systemMessage,
      };
}
