import type {
  ProviderFailureCategory,
  ProviderRetryEventName,
  ProviderRetryEventPayload,
  ProviderRetryScope,
  ReplaySafety,
  RuntimeProvider,
} from "@first-tree/shared";
import {
  buildProviderRetryEvent,
  classifyProviderFailure,
  decideProviderRetry,
  type ProviderFailureClassification,
  type ProviderFailureSource,
  type ProviderRetryDecision,
} from "./provider-retry-policy.js";

type ProviderAttemptSignalKind = "provider_error" | "local_error" | "transport_close" | "diagnostic";

export type ProviderAttemptSignal = {
  kind: ProviderAttemptSignalKind;
  error: unknown;
  source?: ProviderFailureSource;
  replaySafety?: ReplaySafety;
  messagePreview?: string;
};

export type ProviderAttemptSettlement = {
  classification: ProviderFailureClassification;
  decision: ProviderRetryDecision;
  eventName: ProviderRetryEventName;
  eventPayload: ProviderRetryEventPayload;
  messagePreview: string;
};

export type ProviderAttemptOptions = {
  provider: RuntimeProvider;
  scope: ProviderRetryScope;
  source?: ProviderFailureSource;
  replaySafety?: ReplaySafety;
};

export class ProviderAttempt {
  private readonly provider: RuntimeProvider;
  private readonly scope: ProviderRetryScope;
  private readonly source?: ProviderFailureSource;
  private replaySafety: ReplaySafety;
  private strongestFailure: { classification: ProviderFailureClassification; messagePreview: string } | null = null;
  private readonly diagnostics: string[] = [];

  constructor(options: ProviderAttemptOptions) {
    this.provider = options.provider;
    this.scope = options.scope;
    this.source = options.source;
    this.replaySafety = options.replaySafety ?? "pre_provider";
  }

  setReplaySafety(replaySafety: ReplaySafety): void {
    this.replaySafety = replaySafety;
  }

  markUserVisibleOutput(): void {
    this.replaySafety = "user_visible";
  }

  recordSignal(signal: ProviderAttemptSignal): ProviderFailureClassification | null {
    const messagePreview = signal.messagePreview ?? errorMessage(signal.error);
    if (signal.kind === "diagnostic") {
      if (messagePreview.length > 0) this.diagnostics.push(messagePreview);
      const classification = this.classify(signal);
      if (isHardFailureCategory(classification.category)) {
        this.recordFailure(classification, messagePreview);
        return classification;
      }
      return null;
    }

    const classification = this.classify(signal);
    this.recordFailure(classification, messagePreview);
    return classification;
  }

  settle(input: { attempt: number; fallback?: ProviderAttemptSignal; now?: number }): ProviderAttemptSettlement | null {
    if (!this.strongestFailure && input.fallback) this.recordSignal(input.fallback);
    if (!this.strongestFailure) return null;

    const { classification, messagePreview } = this.strongestFailure;
    const decision = decideProviderRetry({
      classification,
      scope: this.scope,
      attempt: input.attempt,
      replaySafety: this.replaySafety,
    });
    const eventName: ProviderRetryEventName =
      decision.action === "retry"
        ? "provider_retry_scheduled"
        : decision.terminalKind === "exhausted"
          ? "provider_retry_exhausted"
          : "provider_failure_terminal";
    const detail = this.messagePreviewWithDiagnostics(messagePreview);
    return {
      classification,
      decision,
      eventName,
      eventPayload: buildProviderRetryEvent({
        event: eventName,
        provider: this.provider,
        scope: this.scope,
        classification,
        decision,
        messagePreview: detail,
        now: input.now,
      }),
      messagePreview: detail,
    };
  }

  private classify(signal: ProviderAttemptSignal): ProviderFailureClassification {
    const source = signal.source ?? this.source;
    return classifyProviderFailure(signal.error, {
      provider: this.provider,
      scope: this.scope,
      ...(source ? { source } : {}),
    });
  }

  private recordFailure(classification: ProviderFailureClassification, messagePreview: string): void {
    if (!this.strongestFailure) {
      this.strongestFailure = { classification, messagePreview };
      return;
    }
    const currentScore = failureCategoryScore(this.strongestFailure.classification.category);
    const nextScore = failureCategoryScore(classification.category);
    if (nextScore > currentScore) this.strongestFailure = { classification, messagePreview };
  }

  private messagePreviewWithDiagnostics(messagePreview: string): string {
    if (this.diagnostics.length === 0) return messagePreview;
    const uniqueDiagnostics = [...new Set(this.diagnostics)].filter((diagnostic) => diagnostic !== messagePreview);
    if (uniqueDiagnostics.length === 0) return messagePreview;
    return [messagePreview, ...uniqueDiagnostics.map((diagnostic) => `diagnostic: ${diagnostic}`)].join("\n");
  }
}

export function isHardFailureCategory(category: ProviderFailureCategory): boolean {
  return (
    category === "credential" ||
    category === "capability" ||
    category === "configuration" ||
    category === "deterministic_input"
  );
}

function failureCategoryScore(category: ProviderFailureCategory): number {
  if (isHardFailureCategory(category)) return 400;
  if (category === "provider_capacity") return 300;
  if (category === "transient_transport") return 200;
  return 100;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
