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

function membersIndexContent(ownerLogin: string): string {
  // Non-empty owners on purpose: `tree tree` skips any directory node whose
  // owners array is empty, so `owners: []` would pass `tree verify` yet make
  // the members domain invisible to the hierarchy browser. Seed the creator as
  // the initial owner; seeding refines this later.
  return `---
title: "Members"
description: "Member definitions and work specifications."
owners: [${ownerLogin}]
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
    { relPath: join("members", "NODE.md"), content: membersIndexContent(opts.ownerLogin) },
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

type BindContext = { orgId: string; isAdmin: boolean };

// Resolve the org to bind AND whether the caller administers it, from a single
// `/me` read. Binding (`settings/context_tree`) is admin-only, so knowing this
// up front lets the command fail before it creates any remote GitHub state.
async function resolveBindContext(serverUrl: string, accessToken: string, override?: string): Promise<BindContext> {
  const res = await fetch(`${serverUrl}/api/v1/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`server returned ${res.status} on /me while resolving the org to bind`);
  }
  const me = (await res.json()) as {
    memberships?: Array<{ organizationId: string; role?: string }>;
    defaultOrganizationId?: string | null;
  };
  const memberships = me.memberships ?? [];

  const explicit = override?.trim();
  let orgId: string;
  if (explicit) {
    orgId = explicit;
  } else if (me.defaultOrganizationId && memberships.some((m) => m.organizationId === me.defaultOrganizationId)) {
    orgId = me.defaultOrganizationId;
  } else if (memberships.length === 1 && memberships[0]) {
    orgId = memberships[0].organizationId;
  } else if (memberships.length === 0) {
    throw new Error("You don't belong to any organization; nothing to bind the tree to.");
  } else {
    throw new Error("Multiple organizations — pass --org <orgId> explicitly or set a default in the web UI first.");
  }

  const membership = memberships.find((m) => m.organizationId === orgId);
  return { orgId, isAdmin: membership?.role === "admin" };
}

type CoverageStatus = "guided" | "no_installation" | "suspended" | "lookup_failed";

type CoverageResult = {
  status: CoverageStatus;
  appSettingsUrl: string | null;
  note: string;
};

function appInstallationSettingsUrl(installation: {
  installationId: number;
  accountLogin: string;
  accountType: string;
}): string {
  // GitHub's "configure installation" page — where a repo-admin edits which
  // repositories a selected-repositories installation can access.
  return installation.accountType === "Organization"
    ? `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
    : `https://github.com/settings/installations/${installation.installationId}`;
}

/**
 * Web snapshots and the Context Tree reviewer read the tree through the team's
 * GitHub App installation, so a newly created repo must be within the
 * installation's reach. When the App itself creates a repo (via its installation
 * token) GitHub auto-attaches it — but `tree init` creates the repo as the *user*
 * with local `gh`, so a *selected-repositories* installation does NOT auto-cover
 * it. Neither the App (no self-add API) nor the local `gh` token (not authorized
 * for this App — `/user/installations/*` returns 403) can add it programmatically,
 * so the reliable path is explicit guidance: point the admin at the installation
 * settings page to include the repo. All-repositories installations already cover
 * it. This never fails the command — the repo is created and bound regardless.
 */
async function resolveInstallationCoverage(
  serverUrl: string,
  accessToken: string,
  orgId: string,
  repoFullName: string,
): Promise<CoverageResult> {
  const res = await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/context-tree/installation`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) {
    return {
      status: "no_installation",
      appSettingsUrl: null,
      note: `No GitHub App installation is connected for this team yet — web snapshots and the Context Tree reviewer will not see ${repoFullName} until an admin installs the First Tree GitHub App and grants it access to this repo.`,
    };
  }
  if (!res.ok) {
    return {
      status: "lookup_failed",
      appSettingsUrl: null,
      note: `Could not read the team's GitHub App installation (server returned ${res.status}). Make sure the First Tree GitHub App can access ${repoFullName}.`,
    };
  }
  const installation = contextTreeInstallationInfoResponseSchema.parse(await res.json());
  const settingsUrl = appInstallationSettingsUrl(installation);
  if (installation.suspended) {
    return {
      status: "suspended",
      appSettingsUrl: settingsUrl,
      note: `The team's GitHub App installation is suspended; reactivate it and include ${repoFullName} before web snapshots and the reviewer can see the tree: ${settingsUrl}`,
    };
  }
  return {
    status: "guided",
    appSettingsUrl: settingsUrl,
    note: `If the First Tree GitHub App is installed on selected repositories, add ${repoFullName} to it so web snapshots and the Context Tree reviewer can read the tree: ${settingsUrl} (all-repositories installations already include it).`,
  };
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
  coverage: CoverageResult | null;
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
    const repoFullName = `${repoOwner}/${repoName}`;
    const treeRoot = resolve(process.cwd(), options.dir?.trim() || repoName);

    if (existsSync(treeRoot) && readdirSync(treeRoot).length > 0) {
      throw new Error(`Target directory is not empty: ${treeRoot}. Pass --dir to choose another path.`);
    }

    // Resolve EVERY First Tree bind precondition (auth, org, admin, installation
    // lookup) BEFORE any remote GitHub write, so a logged-out / multi-org /
    // non-admin caller fails without leaving an orphan created-but-unbound repo.
    let bindContext: { serverUrl: string; accessToken: string; orgId: string } | null = null;
    let coverage: CoverageResult | null = null;
    if (options.bind) {
      const serverUrl = resolveServerUrl();
      const accessToken = await ensureFreshAccessToken();
      const { orgId, isAdmin } = await resolveBindContext(serverUrl, accessToken, options.org);
      if (!isAdmin) {
        throw new Error(
          `Binding the team Context Tree requires admin of org ${orgId}. Re-run with --no-bind to only create the repo, or have an admin bind it later with \`${channelConfig.binName} org bind-tree <url>\`.`,
        );
      }
      coverage = await resolveInstallationCoverage(serverUrl, accessToken, orgId, repoFullName);
      bindContext = { serverUrl, accessToken, orgId };
    }

    // Local scaffold + self-verify (reversible) before touching the remote — a
    // bad seed never reaches GitHub.
    mkdirSync(treeRoot, { recursive: true });
    writeScaffold(
      treeRoot,
      buildScaffoldFiles({ title, ownerLogin: creatorLogin, withWorkflow: options.withWorkflow }),
    );
    runCommand("git", ["init", "-b", DEFAULT_BRANCH], treeRoot);

    const verifySummary = verifyTreeRoot(treeRoot);
    if (!verifySummary.ok) {
      throw new Error(
        `Scaffolded tree failed \`tree verify\`:\n  - ${collectVerifyErrors(verifySummary).join("\n  - ")}`,
      );
    }

    runCommand("git", ["add", "-A"], treeRoot);
    runCommand("git", ["commit", "-m", "chore: bootstrap context tree"], treeRoot);

    // Irreversible remote write: create + push in one shot.
    const visibility = options.public ? "--public" : "--private";
    runCommand(
      "gh",
      ["repo", "create", repoFullName, visibility, "--source", treeRoot, "--remote", "origin", "--push"],
      treeRoot,
    );

    const repo = ghApiJson(`repos/${repoFullName}`);
    const htmlUrl = typeof repo.html_url === "string" ? repo.html_url : "";
    if (!htmlUrl) {
      throw new Error(`Repo created but could not read its URL back from GitHub for ${repoFullName}.`);
    }

    let bound = false;
    if (bindContext) {
      await bindOrgToTree(bindContext.serverUrl, bindContext.accessToken, bindContext.orgId, htmlUrl);
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
      coverage,
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

  if (summary.coverage) {
    console.log("\nGitHub App coverage:");
    console.log(`  ! ${summary.coverage.note}`);
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
    .option("--no-bind", "only create the repo: skip First Tree org binding and the installation-coverage check")
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
