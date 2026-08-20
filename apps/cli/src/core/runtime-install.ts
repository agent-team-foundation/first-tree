import { redactErrorPreview } from "@first-tree/client";
import type { RuntimeInstallProvider, RuntimeInstallResultFrame } from "@first-tree/shared";
import type { InstallClaudeResult } from "./install-claude-runtime.js";
import type { InstallCodexResult } from "./install-codex-runtime.js";

type InstallResult = InstallClaudeResult | InstallCodexResult;

export type RuntimeInstallRunnerDeps = {
  installClaude: () => Promise<InstallClaudeResult>;
  installCodex: () => Promise<InstallCodexResult>;
  reprobe: (provider: RuntimeInstallProvider) => Promise<void>;
  send: (result: RuntimeInstallResultFrame) => void;
  log: (symbol: string, message: string) => void;
};

export type RuntimeInstallRunner = {
  run: (command: { provider: RuntimeInstallProvider; ref: string }) => Promise<void>;
};

function boundedReason(reason: string): string {
  const trimmed = reason.trim() || "Runtime installation failed";
  return redactErrorPreview(trimmed, 499);
}

/**
 * Build the daemon's controlled runtime installer.
 *
 * The caller supplies only an allowlisted provider. Package names, versions,
 * URLs, and shell fragments never cross the wire; each branch invokes the
 * existing installer with its built-in `latest` default. One global in-flight
 * guard prevents concurrent global npm mutations, while terminal cleanup makes
 * both failures and successes immediately retryable.
 */
export function createRuntimeInstallRunner(deps: RuntimeInstallRunnerDeps): RuntimeInstallRunner {
  let active: { provider: RuntimeInstallProvider; ref: string } | null = null;

  const sendFailed = (
    command: { provider: RuntimeInstallProvider; ref: string },
    input: { reason: string; reasonCode: string; retryable: boolean },
  ): void => {
    deps.send({
      type: "runtime-install:result",
      provider: command.provider,
      ref: command.ref,
      status: "failed",
      reason: boundedReason(input.reason),
      reasonCode: input.reasonCode.slice(0, 100) || "runtime_install_failed",
      retryable: input.retryable,
    });
  };

  return {
    async run(command): Promise<void> {
      if (active) {
        sendFailed(command, {
          reason: `A ${active.provider} runtime install is already in progress. Retry after it finishes.`,
          reasonCode: "already_in_progress",
          retryable: true,
        });
        return;
      }

      active = { provider: command.provider, ref: command.ref };
      deps.send({ ...command, type: "runtime-install:result", status: "accepted" });
      deps.send({ ...command, type: "runtime-install:result", status: "in-progress" });
      deps.log("•", `runtime-install: installing ${command.provider} (ref ${command.ref})`);

      try {
        let result: InstallResult;
        if (command.provider === "codex") {
          result = await deps.installCodex();
        } else {
          result = await deps.installClaude();
        }

        if (!result.ok) {
          sendFailed(command, result);
          deps.log("⚠️", `runtime-install: ${command.provider} failed: ${boundedReason(result.reason)}`);
          return;
        }

        try {
          await deps.reprobe(command.provider);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendFailed(command, {
            reason: `Runtime installed, but the capability re-probe failed: ${message}`,
            reasonCode: "capability_reprobe_failed",
            retryable: true,
          });
          deps.log("⚠️", `runtime-install: ${command.provider} re-probe failed: ${boundedReason(message)}`);
          return;
        }

        deps.send({
          type: "runtime-install:result",
          provider: command.provider,
          ref: command.ref,
          status: "succeeded",
          installedVersion: result.installedVersion,
        });
        deps.log("✓", `runtime-install: ${command.provider} installed (ref ${command.ref})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendFailed(command, {
          reason: message,
          reasonCode: "runtime_install_exception",
          retryable: true,
        });
        deps.log("⚠️", `runtime-install: ${command.provider} failed: ${boundedReason(message)}`);
      } finally {
        if (active?.ref === command.ref) active = null;
      }
    },
  };
}
