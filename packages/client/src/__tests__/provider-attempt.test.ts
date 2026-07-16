import { describe, expect, it } from "vitest";
import { ProviderAttempt } from "../runtime/provider-attempt.js";

function attempt() {
  return new ProviderAttempt({ provider: "codex", scope: "provider_turn", source: "sdk" });
}

describe("ProviderAttempt", () => {
  it("does not settle diagnostics alone as a retry", () => {
    const a = attempt();

    a.recordSignal({ kind: "diagnostic", error: new Error("Reconnecting... 2/5 (request timed out)") });

    expect(a.settle({ attempt: 1 })).toBeNull();
  });

  it("records credential diagnostics as terminal failures", () => {
    const a = attempt();

    a.recordSignal({
      kind: "diagnostic",
      error: Object.assign(new Error("unexpected status 401 Unauthorized: Missing bearer or basic authentication"), {
        status: 401,
      }),
    });

    const settled = a.settle({ attempt: 1 });
    expect(settled?.decision).toMatchObject({
      action: "stop",
      terminalKind: "needs_operator",
      reasonCode: "provider_credential_required",
    });
    expect(settled?.eventName).toBe("provider_failure_terminal");
  });

  it("does not let later transient text downgrade a prior hard failure", () => {
    const a = attempt();

    a.recordSignal({
      kind: "provider_error",
      error: Object.assign(new Error("401 Unauthorized"), { status: 401 }),
    });
    a.recordSignal({ kind: "transport_close", error: new Error("request timed out after reconnecting") });

    const settled = a.settle({ attempt: 1 });
    expect(settled?.classification.category).toBe("credential");
    expect(settled?.decision.action).toBe("stop");
  });

  it("classifies compact context-window text as deterministic terminal input", () => {
    const a = attempt();

    a.recordSignal({
      kind: "provider_error",
      error: new Error(
        "Error running remote compact task: Codex ran out of room in the model's context window. Start a new thread.",
      ),
    });

    const settled = a.settle({ attempt: 1 });
    expect(settled?.classification.category).toBe("deterministic_input");
    expect(settled?.decision).toMatchObject({
      action: "stop",
      terminalKind: "deterministic",
    });
  });

  it("keeps diagnostic details while fallback transport drives retry", () => {
    const a = attempt();

    a.recordSignal({ kind: "diagnostic", error: new Error("Reconnecting... 2/5 (request timed out)") });
    const settled = a.settle({
      attempt: 1,
      fallback: { kind: "transport_close", error: new Error("stream ended without completion") },
    });

    expect(settled?.decision).toMatchObject({ action: "retry", reasonCode: "unknown" });
    expect(settled?.messagePreview).toContain("diagnostic: Reconnecting... 2/5");
  });

  it("retries a transient transport failure after user-visible output", () => {
    const a = attempt();

    a.markUserVisibleOutput();
    const settled = a.settle({
      attempt: 1,
      fallback: { kind: "transport_close", error: new Error("fetch failed") },
    });

    expect(settled?.decision).toMatchObject({
      action: "retry",
      replaySafety: "user_visible",
    });
  });
});
