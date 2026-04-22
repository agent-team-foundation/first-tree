/**
 * Classifier selection for `gardener comment`.
 *
 * Selection order (bingran's review on #269):
 *   1. GARDENER_CLASSIFIER env override (claude-cli | anthropic-api | none)
 *   2. `claude` binary on PATH → claude-cli classifier (local dev path)
 *   3. ANTHROPIC_API_KEY set → anthropic-api classifier (CI path)
 *   4. Neither → fail-closed (comment will not post; see #255)
 *
 * Plus: if claude-cli is selected but the subprocess fails with an
 * auth-looking error AND ANTHROPIC_API_KEY is set, transparently
 * retry on the api-key path and emit a one-line warning. This avoids
 * the "I have `claude` installed but logged out, why is gardener
 * broken" failure mode.
 *
 * The retry is implemented by wrapping the claude-cli classifier in
 * a closure that falls back on `ClaudeCliClassifierError` with
 * `kind: "auth_failed"`.
 */

import { spawnSync } from "node:child_process";
import type { Classifier } from "../comment.js";
import { createAnthropicClassifier } from "./anthropic.js";
import {
  ClaudeCliClassifierError,
  createClaudeCliClassifier,
  isAuthFailure,
} from "./claude-cli.js";

export type ClassifierKind = "claude-cli" | "anthropic-api" | "none";

export interface SelectClassifierDeps {
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
  /** Test hook: override PATH probe. */
  claudeBinaryAvailable?: () => boolean;
}

export interface ClassifierSelection {
  kind: ClassifierKind;
  classifier: Classifier | null;
}

export async function selectClassifier(
  deps: SelectClassifierDeps = {},
): Promise<ClassifierSelection> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? ((line: string) => console.log(line));
  const probeBinary = deps.claudeBinaryAvailable ?? defaultClaudeProbe;
  const model = env.GARDENER_CLASSIFIER_MODEL;
  const apiKey = env.ANTHROPIC_API_KEY;
  const override = (env.GARDENER_CLASSIFIER ?? "").trim().toLowerCase();

  if (override === "none") {
    write("gardener: classifier = none (forced via GARDENER_CLASSIFIER)");
    return { kind: "none", classifier: null };
  }
  if (override === "anthropic-api") {
    if (!apiKey) {
      write(
        "gardener: classifier = none — GARDENER_CLASSIFIER=anthropic-api but ANTHROPIC_API_KEY is not set",
      );
      return { kind: "none", classifier: null };
    }
    write("gardener: classifier = anthropic-api (forced via GARDENER_CLASSIFIER)");
    return {
      kind: "anthropic-api",
      classifier: createAnthropicClassifier({ apiKey, model }),
    };
  }
  if (override === "claude-cli") {
    write("gardener: classifier = claude-cli (forced via GARDENER_CLASSIFIER)");
    return {
      kind: "claude-cli",
      classifier: wrapWithApiKeyFallback(
        createClaudeCliClassifier({ model }),
        apiKey,
        model,
        write,
      ),
    };
  }

  // Auto-select.
  if (probeBinary()) {
    write("gardener: classifier = claude-cli (local session auth)");
    return {
      kind: "claude-cli",
      classifier: wrapWithApiKeyFallback(
        createClaudeCliClassifier({ model }),
        apiKey,
        model,
        write,
      ),
    };
  }
  if (apiKey) {
    write("gardener: classifier = anthropic-api (ANTHROPIC_API_KEY)");
    return {
      kind: "anthropic-api",
      classifier: createAnthropicClassifier({ apiKey, model }),
    };
  }
  write(
    "gardener: classifier = none — neither `claude` on PATH nor ANTHROPIC_API_KEY set; comment will not post",
  );
  return { kind: "none", classifier: null };
}

function defaultClaudeProbe(): boolean {
  try {
    const res = spawnSync("claude", ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * If claude-cli throws an auth-failure error and ANTHROPIC_API_KEY is
 * set, transparently retry on the api-key path. Emit a one-line
 * warning so the user understands what happened.
 *
 * Any other error kind (spawn, timeout, non-zero-exit for non-auth
 * reasons, unparseable output) is re-thrown so runComment's existing
 * error pipeline handles it.
 */
function wrapWithApiKeyFallback(
  primary: Classifier,
  apiKey: string | undefined,
  model: string | undefined,
  write: (line: string) => void,
): Classifier {
  if (!apiKey) return primary;
  const secondary = createAnthropicClassifier({ apiKey, model });
  let warned = false;
  return async (input) => {
    try {
      return await primary(input);
    } catch (err) {
      if (!isAuthFailure(err)) throw err;
      if (!warned) {
        const detail = err instanceof ClaudeCliClassifierError
          ? err.stderr.split("\n")[0] ?? ""
          : "";
        write(
          `gardener: claude-cli auth failed — falling back to ANTHROPIC_API_KEY${
            detail ? ` (${detail.slice(0, 120)})` : ""
          }`,
        );
        warned = true;
      }
      return secondary(input);
    }
  };
}
