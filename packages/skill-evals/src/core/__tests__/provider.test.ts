import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";
import { readEvents } from "../events.js";
import { createRunPaths } from "../paths.js";
import { claudeProviderArgs, claudeProviderCommand, claudeProviderEnv, runClaudeProvider } from "../provider/claude.js";
import { codexProviderArgs, codexProviderCommand, codexProviderEnv, runCodexProvider } from "../provider/codex.js";
import type { ProviderRunContext, ProviderRunOptions } from "../provider/types.js";
import { createEvalReporter } from "../reporter.js";
import { createFirstTreeShim } from "../shims/first-tree.js";

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
        provider: "codex",
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
      expect(env.FIRST_TREE_EVAL_EVENTS).toBe(context.paths.modelEventsPath);
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
        `shell_environment_policy.set.FIRST_TREE_EVAL_EVENTS=${JSON.stringify(context.paths.modelEventsPath)}`,
      );
      expect(args).toContain(
        `shell_environment_policy.set.FIRST_TREE_EVAL_VERBOSE=${JSON.stringify(env.FIRST_TREE_EVAL_VERBOSE)}`,
      );
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("merges model-writable shim events back into the run event log", async () => {
    const packageRoot = tempPackageRoot();
    try {
      const codexBinDir = join(packageRoot, "operator-codex-bin");
      mkdirSync(codexBinDir, { recursive: true });
      const codexBin = join(codexBinDir, "codex");
      writeFileSync(
        codexBin,
        [
          "#!/bin/sh",
          "first-tree github issue list >/dev/null 2>/dev/null",
          "printf '%s\\n' '{\"type\":\"turn.completed\"}'",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(codexBin, 0o755);

      const context = fakeContext(packageRoot);
      createFirstTreeShim(context.paths);

      const exitCode = await runCodexProvider(
        {
          bin: codexBin,
          caseId: "provider-hardening-test",
          model: null,
          prompt: "Run the eval case.",
          provider: "codex",
          verbose: false,
        },
        context,
      );

      expect(exitCode).toBe(0);
      const events = readEvents(context.paths.eventsPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            cwd: context.paths.workspacePath,
            event: expect.objectContaining({ type: "turn.completed" }),
            type: "codex_event",
          }),
          expect.objectContaining({
            argv: ["github", "issue", "list"],
            phase: "model",
            type: "first_tree_call",
          }),
          expect.objectContaining({
            argv: ["github", "issue", "list"],
            blockedByEval: true,
            exitCode: 1,
            phase: "model",
            type: "first_tree_result",
          }),
        ]),
      );
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });
});

describe("claude provider runner hardening", () => {
  it("runs Claude Code in print mode with an allowlisted environment", () => {
    const packageRoot = tempPackageRoot();
    try {
      const claudeBinDir = join(packageRoot, "operator-claude-bin");
      const operatorSecretBinDir = join(packageRoot, "operator-secret-bin");
      mkdirSync(claudeBinDir, { recursive: true });
      mkdirSync(operatorSecretBinDir, { recursive: true });
      const claudeBin = join(claudeBinDir, "claude");
      writeFileSync(claudeBin, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(claudeBin, 0o755);

      const context = fakeContext(packageRoot);
      const options: ProviderRunOptions = {
        bin: "claude",
        caseId: "provider-hardening-test",
        model: "claude-test",
        prompt: "Run the eval case.",
        provider: "claude",
        verbose: true,
      };
      const env = claudeProviderEnv(options, context, {
        ANTHROPIC_API_KEY: "allowed",
        FIRST_TREE_SERVER_URL: "https://example.invalid",
        GH_TOKEN: "leaky-gh-token",
        GIT_CONFIG_GLOBAL: "/tmp/leaky-gitconfig",
        HOME: "/operator-home",
        PATH: [operatorSecretBinDir, claudeBinDir].join(delimiter),
      });
      const args = claudeProviderArgs(options);

      expect(claudeProviderCommand(options, { PATH: [operatorSecretBinDir, claudeBinDir].join(delimiter) })).toBe(
        claudeBin,
      );
      expect(args).toEqual([
        "-p",
        "Run the eval case.",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--permission-mode",
        "bypassPermissions",
        "--setting-sources",
        "project",
        "--model",
        "claude-test",
      ]);
      expect(env.HOME).toBe(`${context.paths.runRoot}/provider-home`);
      expect(env.TMPDIR).toBe(`${context.paths.runRoot}/provider-tmp`);
      expect(env.XDG_CACHE_HOME).toBe(`${context.paths.runRoot}/provider-xdg-cache`);
      expect(env.FIRST_TREE_EVAL_EVENTS).toBe(context.paths.modelEventsPath);
      expect(env.ANTHROPIC_API_KEY).toBe("allowed");
      expect(env.FIRST_TREE_SERVER_URL).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
      expect(env.PATH?.split(delimiter)).toEqual(
        unique([context.paths.binDir, dirname(process.execPath), claudeBinDir, "/usr/local/bin", "/usr/bin", "/bin"]),
      );
      expect(env.PATH).not.toContain(operatorSecretBinDir);
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });

  it("merges model-writable shim events and normalizes stream JSON for existing graders", async () => {
    const packageRoot = tempPackageRoot();
    try {
      const claudeBinDir = join(packageRoot, "operator-claude-bin");
      mkdirSync(claudeBinDir, { recursive: true });
      const claudeBin = join(claudeBinDir, "claude");
      writeFileSync(
        claudeBin,
        [
          "#!/bin/sh",
          "first-tree github issue list >/dev/null 2>/dev/null",
          'printf \'%s\\n\' \'{"type":"assistant_message","content":"done"}\'',
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(claudeBin, 0o755);

      const context = fakeContext(packageRoot);
      createFirstTreeShim(context.paths);

      const exitCode = await runClaudeProvider(
        {
          bin: claudeBin,
          caseId: "provider-hardening-test",
          model: null,
          prompt: "Run the eval case.",
          provider: "claude",
          verbose: false,
        },
        context,
      );

      expect(exitCode).toBe(0);
      const events = readEvents(context.paths.eventsPath);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: expect.objectContaining({ content: "done", type: "assistant_message" }),
            type: "claude_event",
          }),
          expect.objectContaining({
            event: expect.objectContaining({ content: "done", type: "assistant_message" }),
            type: "codex_event",
          }),
          expect.objectContaining({
            argv: ["github", "issue", "list"],
            phase: "model",
            type: "first_tree_call",
          }),
        ]),
      );
    } finally {
      rmSync(packageRoot, { force: true, recursive: true });
    }
  });
});
