import { readCanonicalContextTreeWriteRouting } from "@first-tree/client";
import {
  BYO_CONTEXT_ADDITIONAL_CONTEXT_LIMIT,
  type ContextActivationV2Response,
  type ContextIntegrationGrant,
  type ContextIntegrationProject,
  type ContextIntegrationProvider,
} from "@first-tree/shared";
import {
  type ContextActivationValidator,
  type ExternalContextAuthorityMode,
  validateExternalContextAuthority,
} from "./authority.js";
import { resolveContextGrantCandidates } from "./context-binding-store.js";

export type { ContextActivationValidator } from "./authority.js";

type ConnectedResponse = Extract<ContextActivationV2Response, { outcome: "connected" }>;

export type ExternalContextActivation = {
  outcome: "connected" | "disabled" | "unavailable" | "needs_admin" | "ambiguous";
  systemMessage: string;
  additionalContext?: string;
  reasonCode?: string;
  team?: ConnectedResponse["team"];
  grant?: ContextIntegrationGrant;
  candidateCount?: number;
};

/**
 * SessionStart never chooses a Team. It only publishes the neutral BYO router
 * contract after proving that at least one local grant applies. Live Team and
 * Tree authority is checked later by `context route` for exactly those local
 * candidates.
 */
export async function activateExternalContext(
  _validator: ContextActivationValidator,
  input: { provider: ContextIntegrationProvider; project: ContextIntegrationProject },
  dependencies: { resolveCandidates?: typeof resolveContextGrantCandidates } = {},
  _options: { authorityMode?: ExternalContextAuthorityMode } = {},
): Promise<ExternalContextActivation> {
  const candidates = (dependencies.resolveCandidates ?? resolveContextGrantCandidates)(input.provider, input.project);
  if (candidates.length === 0) {
    return {
      outcome: "disabled",
      reasonCode: "grant_missing",
      systemMessage:
        "First Tree Context has no applicable Team grant for this session. Run a Team's BYO setup handoff to add one.",
    };
  }
  return {
    outcome: "connected",
    candidateCount: candidates.length,
    systemMessage: `First Tree Context router ready with ${candidates.length} locally authorized Team candidate${candidates.length === 1 ? "" : "s"}.`,
    additionalContext: buildByoContextAdditionalContext(),
  };
}

export function buildByoContextAdditionalContext(): string {
  return [
    "consumerKind: byo.",
    "At the start of each new task, use first-tree-read to resolve the applicable locally authorized Team before reading any full Context Tree. Selection is fail-closed: if any candidate is unavailable or routing is ambiguous, ask the user — never guess a Team or derive it from cwd.",
    readCanonicalContextTreeWriteRouting(),
    "External BYO provider session; not First Tree Chat/Agent.",
  ].join("\n");
}

export { BYO_CONTEXT_ADDITIONAL_CONTEXT_LIMIT };

/** Kept for human-readable live Team diagnostics, not as the BYO router prompt. */
export function buildConnectedContextAdditionalContext(team: ConnectedResponse["team"]): string {
  return [`Verified Team: ${team.organizationId}; role: ${team.role}.`, buildByoContextAdditionalContext()].join("\n");
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
 * Compatibility guard for operations that have not yet consumed a route
 * receipt. It is deliberately fail-closed when more than one Team is eligible.
 */
export async function requireConnectedExternalContext(
  validator: ContextActivationValidator,
  input: { provider: ContextIntegrationProvider; project: ContextIntegrationProject },
  dependencies: { resolveCandidates?: typeof resolveContextGrantCandidates } = {},
): Promise<{ team: ConnectedResponse["team"]; grant: ContextIntegrationGrant }> {
  const candidates = (dependencies.resolveCandidates ?? resolveContextGrantCandidates)(input.provider, input.project);
  if (candidates.length !== 1) {
    throw new ExternalContextActivationRequiredError(
      candidates.length === 0 ? "disabled" : "ambiguous",
      candidates.length === 0 ? "grant_missing" : "route_required",
      candidates.length === 0
        ? "No applicable First Tree Team grant exists."
        : "More than one Team is eligible. Run the SCOPE router before reading or writing Context Tree content.",
    );
  }
  const [candidate] = candidates;
  if (!candidate) throw new Error("Context grant disappeared after candidate cardinality validation.");
  const grant = candidate.grant;
  const authority = await validateExternalContextAuthority(validator, grant.organizationId, "explicit");
  if (authority.outcome === "unavailable") {
    throw new ExternalContextActivationRequiredError("unavailable", authority.reasonCode, authority.systemMessage);
  }
  if (authority.response.outcome !== "connected") {
    throw new ExternalContextActivationRequiredError(
      "needs_admin",
      authority.response.reasonCode,
      authority.response.nextAction.message,
    );
  }
  return { team: authority.response.team, grant };
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
    : { continue: true, systemMessage: activation.systemMessage };
}
