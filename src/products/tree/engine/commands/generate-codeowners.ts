import { generate } from "../../../../../assets/tree/helpers/generate-codeowners.js";

export const GENERATE_CODEOWNERS_USAGE = `usage: first-tree tree generate-codeowners [--check]

Generate \`.github/CODEOWNERS\` from the Context Tree's NODE.md ownership
frontmatter. Walks the tree, resolves owners (with parent inheritance), and
writes the file.

Options:
  --check        Exit non-zero if CODEOWNERS is out-of-date (don't write)
  --help         Show this help message
`;

export async function runGenerateCodeowners(
  args: string[] = [],
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(GENERATE_CODEOWNERS_USAGE);
    return 0;
  }

  let check = false;
  for (const arg of args) {
    if (arg === "--check") {
      check = true;
      continue;
    }
    console.error(`Unknown generate-codeowners option: ${arg}`);
    console.log(GENERATE_CODEOWNERS_USAGE);
    return 1;
  }

  return generate(process.cwd(), { check });
}
