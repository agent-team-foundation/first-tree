import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { contextTreeBranchSchema } from "@first-tree/shared";
import type * as ejs from "ejs";

// EJS is published as CommonJS at runtime even though its types expose named
// exports, so native ESM cannot `import { render }` directly — mirror the
// client runtime's `agent-briefing.ts` and load it through createRequire.
const require = createRequire(import.meta.url);
const ejsRuntime: typeof ejs = require("ejs");

const TEMPLATE_DIR = "templates";

type LoadedTemplate = { filename: string; source: string };
const templateCache = new Map<string, LoadedTemplate>();

/**
 * The `.ejs` files live next to this module at `./templates/` during source /
 * test execution, and are copied to `dist/templates/` by
 * `scripts/copy-cli-tree-templates.mjs` for the bundled CLI. Try both layouts —
 * the same two-candidate resolution the client runtime uses for its briefing
 * template.
 */
export function resolveScaffoldTemplatePath(name: string): string {
  const candidates = [
    new URL(`./${TEMPLATE_DIR}/${name}`, import.meta.url),
    new URL(`../${TEMPLATE_DIR}/${name}`, import.meta.url),
  ];
  for (const url of candidates) {
    const filename = fileURLToPath(url);
    if (existsSync(filename)) {
      return filename;
    }
  }
  throw new Error(`Context Tree scaffold template is missing: ${TEMPLATE_DIR}/${name}`);
}

function loadTemplate(name: string): LoadedTemplate {
  const cached = templateCache.get(name);
  if (cached) {
    return cached;
  }
  const filename = resolveScaffoldTemplatePath(name);
  const loaded: LoadedTemplate = { filename, source: readFileSync(filename, "utf8") };
  templateCache.set(name, loaded);
  return loaded;
}

function render(name: string, model: Record<string, unknown>): string {
  const template = loadTemplate(name);
  return ejsRuntime.render(template.source, model, { filename: template.filename });
}

// YAML frontmatter values are double-quoted via JSON.stringify so embedded
// quotes / colons stay valid; whitespace is collapsed to keep them single-line.
function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// NOTE: The default-main output of `validate-tree-workflow.yml.ejs` and the
// output of `root-node.md.ejs` are kept byte-for-byte in sync with the server
// one-click bootstrap's `VALIDATE_TREE_WORKFLOW_CONTENT` / `initialRootNode`
// (`packages/server/src/api/orgs/context-tree.ts`) so a tree created by either
// path is identical. There is no cross-package test guarding this (the server
// constants are module-private); if you touch either side, mirror the other.

/** `.github/workflows/validate-tree.yml` — the optional CI workflow (`--with-workflow`). */
export function validateTreeWorkflowContent(branch = "main"): string {
  const validatedBranch = contextTreeBranchSchema.parse(branch);
  // GitHub Actions treats `!` and `+` as branch-pattern operators even though
  // both are valid in Git branch names. Escape them so this filter names the
  // newly created branch literally. The Shared schema rejects backslashes, so
  // no existing escape prefix can change the meaning of this character map.
  const branchPattern = Array.from(validatedBranch, (character) =>
    character === "!" || character === "+" ? `\\${character}` : character,
  ).join("");
  return render("validate-tree-workflow.yml.ejs", {
    branchField: branchPattern === "main" ? "main" : yamlSingleQuote(branchPattern),
  });
}

/** Root `NODE.md` for a freshly created team Context Tree. */
export function rootNodeContent(title: string, ownerLogin: string): string {
  return render("root-node.md.ejs", {
    title,
    ownerLogin,
    titleField: yamlDoubleQuote(`${title} Context Tree`),
    descriptionField: yamlDoubleQuote(`Shared context, decisions, ownership, and operating knowledge for ${title}.`),
  });
}

/** The `members/` domain index node. */
export function membersIndexContent(ownerLogin: string): string {
  return render("members-index.md.ejs", { ownerLogin });
}

/** The creator's `members/<login>/NODE.md` member node. */
export function memberNodeContent(login: string): string {
  return render("member-node.md.ejs", {
    login,
    titleField: yamlDoubleQuote(login),
    descriptionField: yamlDoubleQuote(`Member profile for ${login}.`),
  });
}
