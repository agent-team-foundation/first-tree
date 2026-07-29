import { FirstTreeHubSDK } from "@first-tree/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateExternalContext,
  ExternalContextActivationRequiredError,
  renderProviderSessionStartResponse,
  requireConnectedExternalContext,
} from "../core/context-integration/activation.js";

const preflight = {
  checkoutRoot: "/work/payments",
  repositoryKey: "github.com/acme/payments",
  originUrl: "git@github.com:acme/payments.git",
} as const;

const binding = {
  provider: "codex" as const,
  checkoutRoot: preflight.checkoutRoot,
  repositoryKey: preflight.repositoryKey,
  organizationId: "org_acme",
};

const connected = {
  schemaVersion: 1 as const,
  outcome: "connected" as const,
  team: {
    organizationId: "org_acme",
    displayName: "Acme",
    role: "member" as const,
  },
};

function timeoutError(): Error {
  const error = new Error("request timed out");
  error.name = "TimeoutError";
  return error;
}

function httpError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
}

describe("external Context activation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses only the exact local Team binding and returns a short connected envelope", async () => {
    const validate = vi.fn(async () => connected);
    const result = await activateExternalContext(
      { validateMemberContextActivation: validate },
      { provider: "codex", cwd: "/work/payments/src" },
      {
        inspect: () => preflight,
        findBinding: () => binding,
      },
    );

    expect(validate).toHaveBeenCalledWith(
      "org_acme",
      {
        schemaVersion: 1,
        repositoryKey: "github.com/acme/payments",
      },
      { retry: false, timeoutMs: 2_000 },
    );
    expect(result.outcome).toBe("connected");
    expect(result.additionalContext).toContain("Team: Acme (org_acme)");
    expect(result.additionalContext).toContain("not a First Tree Chat");
    expect(JSON.stringify(renderProviderSessionStartResponse(result)).length).toBeLessThan(2_048);
  });

  it("does not infer a Team when the checkout has no explicit binding", async () => {
    const validate = vi.fn();
    const result = await activateExternalContext(
      { validateMemberContextActivation: validate },
      { provider: "claude-code", cwd: "/work/payments" },
      { inspect: () => preflight, findBinding: () => null },
    );

    expect(result).toMatchObject({ outcome: "disabled", reasonCode: "binding_missing" });
    expect(validate).not.toHaveBeenCalled();
    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "claude-code", cwd: "/work/payments" },
        { inspect: () => preflight, findBinding: () => null },
      ),
    ).rejects.toBeInstanceOf(ExternalContextActivationRequiredError);
  });

  it("fails closed on repository drift and SessionStart timeout without retrying or blocking coding", async () => {
    const drift = await activateExternalContext(
      { validateMemberContextActivation: vi.fn() },
      { provider: "codex", cwd: "/work/payments" },
      {
        inspect: () => preflight,
        findBinding: () => ({
          provider: "codex",
          checkoutRoot: preflight.checkoutRoot,
          repositoryKey: "github.com/acme/other",
          organizationId: "org_acme",
        }),
      },
    );
    expect(drift).toMatchObject({
      outcome: "disabled",
      reasonCode: "binding_repository_drift",
    });

    const validate = vi.fn(async () => {
      throw timeoutError();
    });
    const unavailable = await activateExternalContext(
      { validateMemberContextActivation: validate },
      { provider: "codex", cwd: "/work/payments" },
      {
        inspect: () => preflight,
        findBinding: () => binding,
      },
    );
    expect(unavailable).toMatchObject({
      outcome: "unavailable",
      reasonCode: "authority_timeout",
    });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(validate).toHaveBeenCalledWith(
      "org_acme",
      { schemaVersion: 1, repositoryKey: preflight.repositoryKey },
      { retry: false, timeoutMs: 2_000 },
    );
    expect(renderProviderSessionStartResponse(unavailable)).toMatchObject({ continue: true });
  });

  it("retries one transient explicit activation against the same Team and repository", async () => {
    const validate = vi.fn().mockRejectedValueOnce(timeoutError()).mockResolvedValueOnce(connected);

    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).resolves.toMatchObject({
      team: connected.team,
      binding,
    });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenNthCalledWith(
      1,
      "org_acme",
      { schemaVersion: 1, repositoryKey: preflight.repositoryKey },
      { retry: false, timeoutMs: 5_000 },
    );
    expect(validate).toHaveBeenNthCalledWith(
      2,
      "org_acme",
      { schemaVersion: 1, repositoryKey: preflight.repositoryKey },
      { retry: false, timeoutMs: 5_000 },
    );
  });

  it("bounds a stale-token refresh inside the SessionStart attempt signal", async () => {
    let timeoutController: AbortController | undefined;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      expect(timeoutMs).toBe(2_000);
      timeoutController = new AbortController();
      return timeoutController.signal;
    });
    const getAccessToken = vi.fn(
      (options?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          const signal = options?.signal;
          expect(signal).toBeDefined();
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError")),
            { once: true },
          );
          timeoutController?.abort(timeoutError());
        }),
    );
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      activateExternalContext(
        sdk,
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reasonCode: "authority_timeout",
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["refresh timeout", timeoutError(), "authority_timeout"],
    [
      "refresh network failure",
      Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" }),
      "authority_network_error",
    ],
    ["refresh HTTP 5xx", httpError(503), "authority_server_error"],
  ])("retries one explicit token-stage %s against the same target", async (_label, error, reasonCode) => {
    const getAccessToken = vi.fn(async () => {
      throw error;
    });
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requireConnectedExternalContext(
        sdk,
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).rejects.toMatchObject({
      outcome: "unavailable",
      reasonCode,
    });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not retry a bare EAI_AGAIN token-stage failure during SessionStart", async () => {
    const getAccessToken = vi.fn(async () => {
      throw Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN" });
    });
    const sdk = new FirstTreeHubSDK({
      serverUrl: "https://first-tree.example",
      getAccessToken,
    });

    await expect(
      activateExternalContext(
        sdk,
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).resolves.toMatchObject({
      outcome: "unavailable",
      reasonCode: "authority_network_error",
    });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["timeout", timeoutError(), "authority_timeout"],
    [
      "network failure",
      Object.assign(new Error("fetch failed"), { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }),
      "authority_network_error",
    ],
    ["server failure", httpError(503), "authority_server_error"],
  ])("classifies and bounds explicit %s retries", async (_label, error, reasonCode) => {
    const validate = vi.fn(async () => {
      throw error;
    });

    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).rejects.toMatchObject({
      outcome: "unavailable",
      reasonCode,
    });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "authority_authentication_required"],
    [403, "authority_forbidden"],
    [409, "authority_request_rejected"],
  ])("does not retry deterministic HTTP %i authority failures", async (statusCode, reasonCode) => {
    const validate = vi.fn(async () => {
      throw httpError(statusCode);
    });

    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).rejects.toMatchObject({
      outcome: "unavailable",
      reasonCode,
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("keeps HTTP 403 terminal even when the response message contains timeout text", async () => {
    const validate = vi.fn(async () => {
      throw Object.assign(new Error("request timed out"), { statusCode: 403 });
    });

    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).rejects.toMatchObject({
      outcome: "unavailable",
      reasonCode: "authority_forbidden",
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("classifies HTTP 504 as a retryable server failure before inspecting timeout text", async () => {
    const validate = vi.fn(async () => {
      throw Object.assign(new Error("Gateway Timeout"), { statusCode: 504 });
    });

    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).rejects.toMatchObject({
      outcome: "unavailable",
      reasonCode: "authority_server_error",
    });
    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("does not retry a typed Team scope denial", async () => {
    const validate = vi.fn(async () => ({
      schemaVersion: 1 as const,
      outcome: "disabled" as const,
      team: {
        organizationId: "org_acme",
        displayName: "Acme",
      },
      reasonCode: "repository_not_in_selected_team_scope" as const,
      nextAction: {
        message: "Ask a Team Admin to add this repository.",
        settingsUrl: "https://first-tree.example/settings",
      },
    }));

    await expect(
      requireConnectedExternalContext(
        { validateMemberContextActivation: validate },
        { provider: "codex", cwd: "/work/payments" },
        {
          inspect: () => preflight,
          findBinding: () => binding,
        },
      ),
    ).rejects.toMatchObject({
      outcome: "disabled",
      reasonCode: "repository_not_in_selected_team_scope",
    });
    expect(validate).toHaveBeenCalledTimes(1);
  });
});
