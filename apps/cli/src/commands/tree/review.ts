import type { Command } from "commander";

import type { CommandContext, SubcommandModule } from "../types.js";
import { runTreeReview } from "./review-helper.js";

export const REVIEW_USAGE = `usage: first-tree tree review [--diff PATH] [--output PATH]

Run the tree PR review helper.

Options:
  --diff PATH    path to the PR diff file
  --output PATH  path to write the review JSON
  --help         show this help message`;

function configureReviewCommand(command: Command): void {
  command
    .requiredOption("--diff <path>", "path to the PR diff file")
    .option("--output <path>", "path to write the review JSON");
}

function runReviewCommand(context: CommandContext): void {
  try {
    const options = context.command.opts() as { diff?: string; output?: string };
    const exitCode = runTreeReview({
      diffPath: options.diff ?? "",
      ...(options.output ? { outputPath: options.output } : {}),
    });

    if (exitCode !== 0) {
      process.exitCode = exitCode;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export const reviewCommand: SubcommandModule = {
  name: "review",
  alias: "",
  summary: "",
  description: "Run the tree PR review helper.",
  action: runReviewCommand,
  configure: configureReviewCommand,
};
