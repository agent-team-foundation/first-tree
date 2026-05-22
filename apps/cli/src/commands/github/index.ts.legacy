import type { Command } from "commander";

import type { CommandModule } from "../types.js";
import {
  isGitHubScanHelpRequest,
  readTreeRepoArg,
  requiresGitHubScanBinding,
  resolveGitHubScanBinding,
  stripTreeRepoArg,
} from "./scan-binding.js";

type CommandWithUnknownCommand = Command & {
  unknownCommand(): void;
};

const GITHUB_SCAN_TREE_REPO_ENV = "FIRST_TREE_GITHUB_SCAN_TREE_REPO";

export const githubCommand: CommandModule = {
  name: "github",
  description: "Work with GitHub automation commands.",
  register(program: Command): void {
    const command = program
      .command("github")
      .description("Work with GitHub automation commands.")
      .allowExcessArguments(true)
      .action(() => {
        if (command.args.length > 0) {
          (command as CommandWithUnknownCommand).unknownCommand();
          return;
        }

        command.outputHelp();
      });

    const scanCommand = command
      .command("scan")
      .description("Scan GitHub notifications and dispatch tree-aware work.")
      .argument("[args...]", "github scan sub-command and its arguments")
      .allowUnknownOption(true)
      .helpOption(false)
      .helpCommand(false)
      .action(async (_args: string[]) => {
        const forwardedArgs = [...scanCommand.args];
        const subcommand = forwardedArgs[0];
        const requiresBinding = requiresGitHubScanBinding(subcommand);
        const hasExplicitTreeRepo = readTreeRepoArg(forwardedArgs) !== undefined;
        const shouldResolveBinding = requiresBinding || hasExplicitTreeRepo;
        const previousTreeRepo = process.env[GITHUB_SCAN_TREE_REPO_ENV];
        let resolvedTreeRepo: string | undefined;

        if (shouldResolveBinding && !isGitHubScanHelpRequest(forwardedArgs)) {
          const resolution = resolveGitHubScanBinding(forwardedArgs);

          if (!resolution.ok) {
            console.error(resolution.error);
            process.exitCode = 1;
            return;
          }

          if (requiresBinding && resolution.treeRepo === undefined) {
            console.error(
              [
                "first-tree github scan resolved local binding metadata, but it did not include a published GitHub tree repo.",
                "Run `first-tree tree publish` first, or retry with `--tree-repo <owner/repo>`.",
              ].join("\n"),
            );
            process.exitCode = 1;
            return;
          }

          resolvedTreeRepo = resolution.treeRepo;
        }

        if (resolvedTreeRepo !== undefined) {
          process.env[GITHUB_SCAN_TREE_REPO_ENV] = resolvedTreeRepo;
        }

        try {
          const { runGitHubScan } = await import("@first-tree/github-scan");
          const exitCode = await runGitHubScan(stripTreeRepoArg(forwardedArgs));

          if (typeof exitCode === "number" && exitCode !== 0) {
            process.exitCode = exitCode;
          }
        } finally {
          if (resolvedTreeRepo !== undefined) {
            if (previousTreeRepo === undefined) {
              delete process.env[GITHUB_SCAN_TREE_REPO_ENV];
            } else {
              process.env[GITHUB_SCAN_TREE_REPO_ENV] = previousTreeRepo;
            }
          }
        }
      });

    scanCommand.showSuggestionAfterError(true);
  },
};
