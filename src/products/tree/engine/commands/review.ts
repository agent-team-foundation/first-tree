import { join } from "node:path";
import { resolveBundledAssetRoot, resolveBundledPackageRoot } from "#products/tree/engine/runtime/installer.js";
import { runReview as runReviewImpl } from "../../../../../assets/tree/helpers/run-review.js";

export const REVIEW_USAGE = `usage: first-tree tree review [--diff PATH] [--output PATH]

Run Claude Code PR review against a Context Tree repo. Reads the PR diff,
loads the bundled review prompt and the repo's AGENTS.md/NODE.md, invokes
Claude Code, and writes structured review JSON to the output path.

Designed to run inside CI (the pr-review.yml workflow). Requires the
\`claude\` CLI to be installed and authenticated.

Options:
  --diff PATH    Path to the PR diff file (default: /tmp/pr-diff.txt)
  --output PATH  Path to write the review JSON (default: /tmp/review.json)
  --help         Show this help message
`;

export async function runReview(args: string[] = []): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(REVIEW_USAGE);
    return 0;
  }

  let diffPath: string | undefined;
  let outputPath: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--diff") {
      diffPath = args[i + 1];
      if (!diffPath) {
        console.error("Missing value for --diff");
        return 1;
      }
      i += 1;
      continue;
    }
    if (arg === "--output") {
      outputPath = args[i + 1];
      if (!outputPath) {
        console.error("Missing value for --output");
        return 1;
      }
      i += 1;
      continue;
    }
    console.error(`Unknown review option: ${arg}`);
    console.log(REVIEW_USAGE);
    return 1;
  }

  const packageRoot = resolveBundledPackageRoot();
  const reviewPromptPath = join(
    resolveBundledAssetRoot(packageRoot),
    "prompts",
    "pr-review.md",
  );

  return runReviewImpl({ diffPath, outputPath, reviewPromptPath });
}
