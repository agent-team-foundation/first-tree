import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { createRunPaths } from "../paths.js";
import { codexProviderArgs, codexProviderCommand, codexProviderEnv } from "../provider/codex.js";
import type { ProviderRunContext, ProviderRunOptions } from "../provider/types.js";
import { createEvalReporter } from "../reporter.js";

function tempPackageRoot(): string {
  return mkdtempSync(join(tmpdir(), "skill-evals-provider-test-"));
}

function fakeContext(packageRoot: string): ProviderRunContext {
  return {
    paths: createRunPaths({
      caseId: "provider-hardening-test",
      packageRoot,
      startedAt: "2026-06-29T00:00:00.000Z",
    }),
    reporter: createEvalReporter("provider-hardening-test", false),
  };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

describe("codex provider runner hardening", () => {
  it("runs live codex with a workspace sandbox and an allowlisted environment", () => {
    const packageRoot = tempPackageRoot();
    try {
      const codexBinDir = join(packageRoot, "operator-codex-bin");
      const operatorSecretBinDir = join(packageRoot, "operator-secret-bin");
      mkdirSync(codexBinDir, { recursive: true });
      mkdirSync(operatorSecretBinDir, { recursive: true });
      const codexBin = join(codexBinDir, "codex");
      writeFileSync(codexBin, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(codexBin, 0o755);

      const context = fakeContext(packageRoot);
      const options: ProviderRunOptions = {
        bin: "codex",
        caseId: "provider-hardening-test",
        model: "gpt-test",
        prompt: "Run the eval case.",
        verbose: true,
      };
      const env = codexProviderEnv(options, context, {
        CODEX_HOME: "/codex-auth-home",
        FIRST_TREE_SERVER_URL: "https://example.invalid",
        GH_TOKEN: "leaky-gh-token",
        GIT_CONFIG_GLOBAL: "/tmp/leaky-gitconfig",
        HOME: "/operator-home",
        OPENAI_API_KEY: "allowed",
        PATH: [operatorSecretBinDir, codexBinDir].join(delimiter),
      });
      const args = codexProviderArgs(options, context.paths.workspacePath, env);

      expect(codexProviderCommand(options, { PATH: [operatorSecretBinDir, codexBinDir].join(delimiter) })).toBe(
        codexBin,
      );
      expect(args).toContain("--ignore-user-config");
      expect(args).toContain("--ignore-rules");
      expect(args).toContain("--sandbox");
      expect(args).toContain("workspace-write");
      expect(args).toContain("shell_environment_policy.inherit=none");
      expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(args).not.toContain("shell_environment_policy.inherit=all");
      expect(args).toContain("--model");
      expect(args).toContain("gpt-test");
      expect(args.at(-1)).toBe("Run the eval case.");

      expect(env.HOME).toBe(`${context.paths.runRoot}/provider-home`);
      expect(env.TMPDIR).toBe(`${context.paths.runRoot}/provider-tmp`);
      expect(env.XDG_CACHE_HOME).toBe(`${context.paths.runRoot}/provider-xdg-cache`);
      expect(env.CODEX_HOME).toBe("/codex-auth-home");
      expect(env.OPENAI_API_KEY).toBe("allowed");
      expect(env.FIRST_TREE_SERVER_URL).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(env.PATH?.split(delimiter)).toEqual(
        unique([context.paths.binDir, dirname(process.execPath), codexBinDir, "/usr/local/bin", "/usr/bin", "/bin"]),
      );
      expect(env.PATH).not.toContain(operatorSecretBinDir);
      expect(args).toContain(`shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`);
      expect(args).toContain(`shell_environment_policy.set.HOME=${JSON.stringify(env.HOME)}`);
      expect(args).toContain(`shell_environment_policy.set.TMPDIR=${JSON.stringify(env.TMPDIR)}`);
      expect(args).toContain(
        `shell_environment_policy.set.FIRST_TREE_EVAL_VERBOSE=${JSON.stringify(env.FIRST_TREE_EVAL_VERBOSE)}`,
      );
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });
});
