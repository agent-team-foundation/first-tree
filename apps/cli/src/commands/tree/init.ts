import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { contextTreeInstallationInfoResponseSchema } from "@first-tree/shared";
import type { Command } from "commander";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import { ensureTrailingNewline, runCommand } from "./shared.js";
import { type VerifySummary, verifyTreeRoot } from "./verify.js";

const REPO_SUFFIX = "-context-tree";
const GITHUB_REPO_NAME_MAX_LENGTH = 100;
const DEFAULT_BRANCH = "main";

// Kept byte-for-byte in sync with the server's one-click bootstrap
// (`packages/server/src/api/orgs/context-tree.ts`) so a tree created either way
// runs the same CI. Only seeded when `--with-workflow` is passed, because
// writing under `.github/workflows/` needs the interactive `workflow` gh scope
// (`gh auth refresh -s workflow`); the default path skips it and stays
// frictionless — the workflow is optional CI, not required for a valid tree.
const VALIDATE_TREE_WORKFLOW = `name: Validate Context Tree

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4
      - name: Validate Context Tree
        run: npx -p first-tree first-tree tree verify
`;

export type TreeInitOptions = {
  owner?: string;
  name?: string;
  title?: string;
  public: boolean;
  dir?: string;
  withWorkflow: boolean;
  bind: boolean;
  org?: string;
};

export type ScaffoldFile = { relPath: string; content: string };

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value.replace(/\s+/g, " ").trim());
}

// Mirror the server's `slugifyRepoBase` byte-for-byte (NFKD strip + hyphenate +
// collapse), including the `team` fallback, so agent-created and Cloud-created
// trees derive the same repo name from the same team name.
function slugifyRepoBase(value: string): string {
  const ascii = value.normalize("NFKD").replace(/[̀-ͯ]/gu, "");
  const slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
  return slug || "team";
}

/**
 * `<slug>-context-tree`, capped at GitHub's 100-char repo-name limit. Mirrors
 * the server-side `contextTreeRepoName` so agent-created and Cloud-created trees
 * are named identically.
 */
export function defaultRepoName(title: string): string {
  const maxBaseLength = GITHUB_REPO_NAME_MAX_LENGTH - REPO_SUFFIX.length;
  const base = slugifyRepoBase(title).slice(0, maxBaseLength).replace(/-+$/gu, "") || "team";
  return `${base}${REPO_SUFFIX}`;
}

function rootNodeContent(title: string, ownerLogin: string): string {
  const description = `Shared context, decisions, ownership, and operating knowledge for ${title}.`;
  return `---
title: ${yamlDoubleQuote(`${title} Context Tree`)}
description: ${yamlDoubleQuote(description)}
owners: [${ownerLogin}]
---

# ${title}'s Context Tree
`;
}

function membersIndexContent(): string {
  return `---
title: "Members"
description: "Member definitions and work specifications."
owners: []
---

# Members

Member definitions, work scope, and personal node specifications. Members are
both humans and AI agents — each has a personal node under \`members/<id>/\`.
`;
}

function memberNodeContent(login: string): string {
  return `---
title: ${yamlDoubleQuote(login)}
description: ${yamlDoubleQuote(`Member profile for ${login}.`)}
owners: [${login}]
type: human
role: "Team member"
domains:
  - "context-tree"
---

# ${login}

Initial member node, created when the team Context Tree was bootstrapped.
Replace this with a short description of what you own and decide.
`;
}

/**
 * The minimal file set that makes a fresh tree pass `first-tree tree verify`:
 * a root `NODE.md`, the `members/` domain index, and one member node for the
 * creator (verify hard-fails on a `members/` dir with no member nodes).
 */
export function buildScaffoldFiles(opts: { title: string; ownerLogin: string; withWorkflow: boolean }): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { relPath: "NODE.md", content: rootNodeContent(opts.title, opts.ownerLogin) },
    { relPath: join("members", "NODE.md"), content: membersIndexContent() },
    { relPath: join("members", opts.ownerLogin, "NODE.md"), content: memberNodeContent(opts.ownerLogin) },
  ];
  if (opts.withWorkflow) {
    files.push({ relPath: join(".github", "workflows", "validate-tree.yml"), content: VALIDATE_TREE_WORKFLOW });
  }
  return files;
}

function writeScaffold(dir: string, files: ScaffoldFile[]): void {
  for (const file of files) {
    const abs = join(dir, file.relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, ensureTrailingNewline(file.content.trimEnd()));
  }
}

function collectVerifyErrors(summary: VerifySummary): string[] {
  return Object.values(summary.checks).flatMap((check) => check.errors ?? []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureToolAvailable(tool: string): void {
  try {
    runCommand(tool, ["--version"], process.cwd());
  } catch {
    throw new Error(`\`${tool}\` is required but was not found on PATH. Install it and try again.`);
  }
}

function ensureGhAuthenticated(): void {
  try {
    runCommand("gh", ["auth", "status"], process.cwd());
  } catch {
    throw new Error("GitHub CLI is not authenticated. Run `gh auth login` and try again.");
  }
}

function ghApiText(args: string[]): string {
  return runCommand("gh", ["api", ...args], process.cwd());
}

function ghApiJson(endpoint: string): Record<string, unknown> {
  const raw = ghApiText([endpoint]);
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`Unexpected GitHub API response for ${endpoint}`);
  }
  return parsed;
}

async function resolveOrgId(serverUrl: string, accessToken: string, override?: string): Promise<string> {
  const explicit = override?.trim();
  if (explicit) {
    return explicit;
  }
  const res = await fetch(`${serverUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`server returned ${res.status} on /me while resolving the org to bind`);
  }
  const me = (await res.json()) as {
    memberships?: Array<{ organizationId: string }>;
    defaultOrganizationId?: string | null;
  };
  const memberships = me.memberships ?? [];
  if (me.defaultOrganizationId && memberships.some((m) => m.organizationId === me.defaultOrganizationId)) {
    return me.defaultOrganizationId;
  }
  if (memberships.length === 1 && memberships[0]) {
    return memberships[0].organizationId;
  }
  if (memberships.length === 0) {
    throw new Error("You don't belong to any organization; nothing to bind the tree to.");
  }
  throw new Error("Multiple organizations — pass --org <orgId> explicitly or set a default in the web UI first.");
}

type InstallationCoverage = "covered" | "added" | "skipped";

/**
 * Ensure the freshly created tree repo is reachable by the team's GitHub App
 * installation, so web snapshots and the Context Tree reviewer webhook work.
 * This replaces the old server-side `administration/contents/workflows: write`
 * live-check: the server/App cannot add a repo to its own installation, but the
 * user who administers it can (`PUT /user/installations/{id}/repositories/{id}`).
 * Best-effort — any miss appends actionable guidance to `warnings` rather than
 * failing the whole command, because the repo is already created and bound.
 */
async function ensureInstallationCoverage(args: {
  serverUrl: string;
  accessToken: string;
  orgId: string;
  repoOwner: string;
  repoName: string;
  repoId: number;
  warnings: string[];
}): Promise<InstallationCoverage> {
  const { serverUrl, accessToken, orgId, repoOwner, repoName, repoId, warnings } = args;
  const manualHint = `Add it manually: install/adjust the First Tree GitHub App so it can access ${repoOwner}/${repoName}.`;

  const res = await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/context-tree/installation`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    warnings.push(
      `No GitHub App installation is connected for this team yet, so the web snapshot and Context Tree reviewer will not see ${repoOwner}/${repoName} until the App is installed. ${manualHint}`,
    );
    return "skipped";
  }
  if (!res.ok) {
    warnings.push(`Could not read the team's GitHub App installation (server returned ${res.status}). ${manualHint}`);
    return "skipped";
  }
  const installation = contextTreeInstallationInfoResponseSchema.parse(await res.json());
  if (installation.suspended) {
    warnings.push(
      `The team's GitHub App installation is suspended; ${repoOwner}/${repoName} cannot be covered until it is reactivated. ${manualHint}`,
    );
    return "skipped";
  }

  // Read the installation's repository selection from the user's own gh — an
  // "all" install already covers the new repo; only "selected" needs the add.
  let selection: string;
  try {
    selection = ghApiText([
      "--paginate",
      "/user/installations",
      "--jq",
      `first(.installations[] | select(.id == ${installation.installationId}) | .repository_selection)`,
    ]).trim();
  } catch {
    warnings.push(`Your local gh could not read installation ${installation.installationId}. ${manualHint}`);
    return "skipped";
  }
  if (selection === "") {
    warnings.push(
      `Your local gh does not see installation ${installation.installationId} (wrong account or missing scope). ${manualHint}`,
    );
    return "skipped";
  }
  if (selection === "all") {
    return "covered";
  }

  try {
    runCommand(
      "gh",
      ["api", "--method", "PUT", `/user/installations/${installation.installationId}/repositories/${repoId}`],
      process.cwd(),
    );
    return "added";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    warnings.push(
      `Failed to add ${repoOwner}/${repoName} to installation ${installation.installationId}: ${detail}. ${manualHint}`,
    );
    return "skipped";
  }
}

async function bindOrgToTree(serverUrl: string, accessToken: string, orgId: string, repoUrl: string): Promise<void> {
  const res = await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/settings/context_tree`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ repo: repoUrl }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Repo created and pushed, but binding failed (server returned ${res.status}). Retry with \`${channelConfig.binName} org bind-tree ${repoUrl}\`. ${text.slice(0, 200)}`,
    );
  }
}

type TreeInitSummary = {
  repo: string;
  htmlUrl: string;
  owner: string;
  name: string;
  treeRoot: string;
  branch: string;
  withWorkflow: boolean;
  bound: boolean;
  installationCoverage: InstallationCoverage | null;
  warnings: string[];
};

function readOptions(command: Command): TreeInitOptions {
  const raw = command.opts() as {
    owner?: string;
    name?: string;
    title?: string;
    public?: boolean;
    dir?: string;
    withWorkflow?: boolean;
    bind?: boolean;
    org?: string;
  };
  return {
    owner: raw.owner,
    name: raw.name,
    title: raw.title,
    public: raw.public === true,
    dir: raw.dir,
    withWorkflow: raw.withWorkflow === true,
    // commander maps `--no-bind` to `bind: false`; default is bind: true.
    bind: raw.bind !== false,
    org: raw.org,
  };
}

async function runInitCommand(context: CommandContext): Promise<void> {
  try {
    const options = readOptions(context.command);

    ensureToolAvailable("git");
    ensureToolAvailable("gh");
    ensureGhAuthenticated();

    const creatorLogin = ghApiText(["user", "--jq", ".login"]).trim();
    if (!creatorLogin) {
      throw new Error("Could not resolve your GitHub login from `gh api user`.");
    }
    const repoOwner = options.owner?.trim() || creatorLogin;
    const title = options.title?.trim() || repoOwner;
    const repoName = options.name?.trim() || defaultRepoName(title);
    const treeRoot = resolve(process.cwd(), options.dir?.trim() || repoName);

    if (existsSync(treeRoot) && readdirSync(treeRoot).length > 0) {
      throw new Error(`Target directory is not empty: ${treeRoot}. Pass --dir to choose another path.`);
    }
    mkdirSync(treeRoot, { recursive: true });

    // Scaffold the minimal valid tree and verify it BEFORE creating anything
    // remote, so a bad seed never reaches GitHub.
    writeScaffold(
      treeRoot,
      buildScaffoldFiles({ title, ownerLogin: creatorLogin, withWorkflow: options.withWorkflow }),
    );
    runCommand("git", ["init", "-b", DEFAULT_BRANCH], treeRoot);

    const summary = verifyTreeRoot(treeRoot);
    if (!summary.ok) {
      throw new Error(`Scaffolded tree failed \`tree verify\`:\n  - ${collectVerifyErrors(summary).join("\n  - ")}`);
    }

    runCommand("git", ["add", "-A"], treeRoot);
    runCommand("git", ["commit", "-m", "chore: bootstrap context tree"], treeRoot);

    const visibility = options.public ? "--public" : "--private";
    runCommand(
      "gh",
      ["repo", "create", `${repoOwner}/${repoName}`, visibility, "--source", treeRoot, "--remote", "origin", "--push"],
      treeRoot,
    );

    const repo = ghApiJson(`repos/${repoOwner}/${repoName}`);
    const repoId = Number(repo.id);
    const htmlUrl = typeof repo.html_url === "string" ? repo.html_url : "";
    if (!Number.isFinite(repoId) || !htmlUrl) {
      throw new Error(`Repo created but could not read its id/url back from GitHub for ${repoOwner}/${repoName}.`);
    }

    const warnings: string[] = [];
    let bound = false;
    let installationCoverage: InstallationCoverage | null = null;

    if (options.bind) {
      const serverUrl = resolveServerUrl();
      const accessToken = await ensureFreshAccessToken();
      const orgId = await resolveOrgId(serverUrl, accessToken, options.org);
      installationCoverage = await ensureInstallationCoverage({
        serverUrl,
        accessToken,
        orgId,
        repoOwner,
        repoName,
        repoId,
        warnings,
      });
      await bindOrgToTree(serverUrl, accessToken, orgId, htmlUrl);
      bound = true;
    }

    printSummary(context, {
      repo: htmlUrl,
      htmlUrl,
      owner: repoOwner,
      name: repoName,
      treeRoot,
      branch: DEFAULT_BRANCH,
      withWorkflow: options.withWorkflow,
      bound,
      installationCoverage,
      warnings,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function printSummary(context: CommandContext, summary: TreeInitSummary): void {
  if (context.options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log("Context Tree Init\n");
  console.log(`  Repository:   ${summary.owner}/${summary.name}`);
  console.log(`  URL:          ${summary.htmlUrl}`);
  console.log(`  Local tree:   ${summary.treeRoot}`);
  console.log(`  Branch:       ${summary.branch}`);
  console.log(
    `  Validate CI:  ${summary.withWorkflow ? "seeded" : "not seeded (optional; needs gh `workflow` scope)"}`,
  );
  console.log(`  Bound to org: ${summary.bound ? "yes" : "no (--no-bind)"}`);
  if (summary.installationCoverage) {
    const label = {
      covered: "already covered (all-repositories install)",
      added: "added to the App installation",
      skipped: "not added — see warnings",
    }[summary.installationCoverage];
    console.log(`  App coverage: ${label}`);
  }

  if (summary.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of summary.warnings) {
      console.log(`  ! ${warning}`);
    }
  }

  console.log(summary.bound ? "\nContext Tree created and bound." : "\nContext Tree created.");
}

function configureInitCommand(command: Command): void {
  command
    .option("--owner <login>", "GitHub owner (user or org) to create the repo under; defaults to the authed gh user")
    .option("--name <repo>", "repository name; defaults to <team>-context-tree")
    .option("--title <team>", "team display name used in the root node title; defaults to the owner")
    .option("--public", "create a public repository (default: private)")
    .option("--dir <path>", "local directory to scaffold and push from; defaults to ./<name>")
    .option("--with-workflow", "also seed .github/workflows/validate-tree.yml (needs gh `workflow` scope)")
    .option("--no-bind", "skip binding the org and adding the repo to the App installation")
    .option("--org <orgId>", "org to bind; defaults to your selected/default org via /me");
}

export const initCommand: SubcommandModule = {
  name: "init",
  alias: "",
  summary: "",
  description: "Create a new team Context Tree repo with local gh, seed it, push, and bind it.",
  action: runInitCommand,
  configure: configureInitCommand,
};
