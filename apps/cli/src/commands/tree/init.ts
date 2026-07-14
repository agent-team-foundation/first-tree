import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  classifyContextTreeSetting,
  contextTreeActiveBindingSchema,
  contextTreeInstallationInfoResponseSchema,
} from "@first-tree/shared";
import type { Command } from "commander";
import { ensureFreshAccessToken, resolveServerUrl } from "../../core/bootstrap.js";
import { channelConfig } from "../../core/channel.js";
import type { CommandContext, SubcommandModule } from "../types.js";
import {
  memberNodeContent,
  membersIndexContent,
  rootNodeContent,
  validateTreeWorkflowContent,
} from "./scaffold-templates.js";
import { ensureTrailingNewline, runCommand } from "./shared.js";
import { type VerifySummary, verifyTreeRoot } from "./verify.js";

const REPO_SUFFIX = "-context-tree";
const GITHUB_REPO_NAME_MAX_LENGTH = 100;
const DEFAULT_BRANCH = "main";

export type TreeInitOptions = {
  owner?: string;
  name?: string;
  title?: string;
  public: boolean;
  dir?: string;
  withWorkflow: boolean;
  bind: boolean;
  rebind: boolean;
  org?: string;
};

export type ScaffoldFile = { relPath: string; content: string };

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

/**
 * The minimal file set that makes a fresh tree pass `first-tree tree verify`:
 * a root `NODE.md`, the `members/` domain index, and one member node for the
 * creator (verify hard-fails on a `members/` dir with no member nodes). The node
 * bodies are rendered from `./templates/*.ejs` (see `scaffold-templates.ts`).
 */
export function buildScaffoldFiles(opts: {
  title: string;
  ownerLogin: string;
  withWorkflow: boolean;
  branch?: string;
}): ScaffoldFile[] {
  const files: ScaffoldFile[] = [
    { relPath: "NODE.md", content: rootNodeContent(opts.title, opts.ownerLogin) },
    { relPath: join("members", "NODE.md"), content: membersIndexContent(opts.ownerLogin) },
    { relPath: join("members", opts.ownerLogin, "NODE.md"), content: memberNodeContent(opts.ownerLogin) },
  ];
  if (opts.withWorkflow) {
    files.push({
      relPath: join(".github", "workflows", "validate-tree.yml"),
      content: validateTreeWorkflowContent(opts.branch ?? DEFAULT_BRANCH),
    });
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

type InstallationInfo = { installationId: number; accountLogin: string; accountType: string; suspended: boolean };
type InstallationLookup = { kind: "ok"; data: InstallationInfo } | { kind: "none" } | { kind: "error"; status: number };

// Never throws: a network/timeout/parse failure returns `{ kind: "error" }` so
// the caller decides (bound path fails closed rather than guessing the owner; a
// pure informational read would degrade to a note).
async function fetchInstallation(serverUrl: string, accessToken: string, orgId: string): Promise<InstallationLookup> {
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/context-tree/installation`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { kind: "error", status: 0 };
  }
  if (res.status === 404) {
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && "code" in body && body.code === "no_installation") {
        return { kind: "none" };
      }
    } catch {
      // An unrelated or malformed 404 must remain fail-closed.
    }
    return { kind: "error", status: res.status };
  }
  if (!res.ok) {
    return { kind: "error", status: res.status };
  }
  try {
    return { kind: "ok", data: contextTreeInstallationInfoResponseSchema.parse(await res.json()) };
  } catch {
    return { kind: "error", status: res.status };
  }
}

/**
 * The tree repo must live under the *same GitHub account as the App
 * installation* — an installation is scoped to one account, so a repo under any
 * other account can never be covered (not even by an all-repositories install).
 * In the bound path we therefore default the owner to the installation account
 * and reject a mismatching `--owner`. Only `--no-bind` / no-installation flows
 * fall back to the local `gh` user, where the repo is explicitly unverified.
 */
export function resolveRepoOwner(args: {
  optionOwner?: string;
  creatorLogin: string;
  installationAccount: string | null;
}): string {
  const explicit = args.optionOwner?.trim();
  if (args.installationAccount) {
    // GitHub account names are case-insensitive, so compare case-folded; always
    // return the installation account's canonical casing.
    if (explicit && explicit.toLowerCase() !== args.installationAccount.toLowerCase()) {
      throw new Error(
        `--owner ${explicit} does not match this team's GitHub App installation account (${args.installationAccount}). The tree repo must live under ${args.installationAccount} so the App can cover it — omit --owner to use it, or pass --no-bind to create it elsewhere without binding.`,
      );
    }
    return args.installationAccount;
  }
  return explicit || args.creatorLogin;
}

/**
 * Web snapshots and the Context Tree reviewer read the tree through the team's
 * GitHub App installation, so a newly created repo must be within its reach.
 * When the App itself creates a repo (via its installation token) GitHub
 * auto-attaches it — but `tree init` creates the repo as the *user* with local
 * `gh`, so a *selected-repositories* installation does NOT auto-cover it. Neither
 * the App (no self-add API) nor the local `gh` token (not authorized for this App
 * — `/user/installations/*` returns 403) can add it programmatically, so the
 * reliable path is explicit guidance: point the admin at the installation
 * settings page to include the repo. All-repositories installations already cover
 * it. This never fails the command — the repo is created and bound regardless.
 */
function buildCoverage(lookup: InstallationLookup, repoFullName: string): CoverageResult {
  if (lookup.kind === "none") {
    return {
      status: "no_installation",
      appSettingsUrl: null,
      note: `No GitHub App installation is connected for this team yet — web snapshots and the Context Tree reviewer will not see ${repoFullName} until an admin installs the First Tree GitHub App and grants it access to this repo.`,
    };
  }
  if (lookup.kind === "error") {
    return {
      status: "lookup_failed",
      appSettingsUrl: null,
      note: `Could not read the team's GitHub App installation (server returned ${lookup.status}). Make sure the First Tree GitHub App can access ${repoFullName}.`,
    };
  }
  const installation = lookup.data;
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

// Read the raw `context_tree` repair view so `tree init` can retain a valid
// unbound branch while rejecting active or invalid historical settings. A
// missing raw endpoint marks an old Server that cannot offer conflict-safe
// finalization, so non-rebind callers fail before creating a GitHub repository.
async function readContextTreeBinding(
  serverUrl: string,
  accessToken: string,
  orgId: string,
): Promise<{ repo: string | null; branch: string; supportsConditionalFinalize: boolean }> {
  const raw = await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/settings/context_tree/raw`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  const rawSupported = raw.status !== 404;
  const res = rawSupported
    ? raw
    : await fetch(`${serverUrl}/api/v1/orgs/${encodeURIComponent(orgId)}/settings/context_tree`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(10_000),
      });
  if (!res.ok) {
    throw new Error(
      `Could not read the team's current Context Tree binding (server returned ${res.status}); refusing to proceed so an existing tree is not replaced. Retry, or pass --no-bind.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const state = classifyContextTreeSetting(body);
  if (state.kind === "invalid") {
    throw new Error(
      "The team's current Context Tree setting contains invalid historical data; refusing to create a repository until an admin repairs both its repo and branch.",
    );
  }
  return state.kind === "bound"
    ? {
        repo: state.binding.repo,
        branch: state.binding.branch,
        supportsConditionalFinalize: raw.status !== 404,
      }
    : { repo: null, branch: state.branch, supportsConditionalFinalize: raw.status !== 404 };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function explicitBindCommand(repoUrl: string, orgId: string, branch: string): string {
  return `${channelConfig.binName} org bind-tree ${shellQuote(repoUrl)} --org ${shellQuote(orgId)} --branch ${shellQuote(branch)}`;
}

async function bindOrgToTree(args: {
  serverUrl: string;
  accessToken: string;
  orgId: string;
  repoUrl: string;
  branch: string;
  rebind: boolean;
}): Promise<void> {
  const path = args.rebind ? "settings/context_tree" : "settings/context_tree/initialize";
  const endpoint = `${args.serverUrl}/api/v1/orgs/${encodeURIComponent(args.orgId)}/${path}`;
  const requestBody = args.rebind
    ? { repo: args.repoUrl, branch: args.branch }
    : { repo: args.repoUrl, branch: args.branch, expectedUnboundBranch: args.branch };
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: args.rebind ? "PUT" : "POST",
      headers: { Authorization: `Bearer ${args.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    const retry = explicitBindCommand(args.repoUrl, args.orgId, args.branch);
    throw new Error(
      `Repo created and pushed, but the binding outcome is unknown for organization ${args.orgId} after a network or timeout failure. Do not retry the write until you read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree. The intended binding is repo ${args.repoUrl} at branch ${args.branch}. If that setting is still unbound and you intentionally want to bind it, run \`${retry}\`.`,
    );
  }
  if (!res.ok) {
    if (!args.rebind && res.status === 409) {
      throw new Error(
        `Repo created and pushed, but organization ${args.orgId}'s Context Tree setting changed before finalization (server returned 409). The competing setting was preserved; do not retry or overwrite it. Read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree first. The newly created repo is ${args.repoUrl} at branch ${args.branch}.`,
      );
    }
    if (!args.rebind && res.status === 404) {
      throw new Error(
        `Repo created and pushed, but this server does not support conflict-safe tree init finalization for organization ${args.orgId}. No binding was written. Upgrade the server, then read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree before deciding how to bind repo ${args.repoUrl} at branch ${args.branch}.`,
      );
    }
    const retry = explicitBindCommand(args.repoUrl, args.orgId, args.branch);
    throw new Error(
      `Repo created and pushed, but binding failed (server returned ${res.status}) for organization ${args.orgId}. Read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree before any retry. The intended binding is repo ${args.repoUrl} at branch ${args.branch}. If that setting is still unbound and you intentionally want to bind it, run \`${retry}\`.`,
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const hasExplicitBindingFields =
    body !== null &&
    typeof body === "object" &&
    "repo" in body &&
    typeof body.repo === "string" &&
    "branch" in body &&
    typeof body.branch === "string";
  const binding = contextTreeActiveBindingSchema.safeParse(body);
  if (
    !hasExplicitBindingFields ||
    !binding.success ||
    binding.data.repo !== args.repoUrl ||
    binding.data.branch !== args.branch
  ) {
    const retry = explicitBindCommand(args.repoUrl, args.orgId, args.branch);
    throw new Error(
      `Repo created and pushed, but the binding outcome is unknown because the server did not confirm the requested Context Tree binding for organization ${args.orgId}. Do not retry the write until you read back /api/v1/orgs/${encodeURIComponent(args.orgId)}/settings/context_tree. The intended binding is repo ${args.repoUrl} at branch ${args.branch}. If that setting is still unbound and you intentionally want to bind it, run \`${retry}\`.`,
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
    rebind?: boolean;
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
    rebind: raw.rebind === true,
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

    // Resolve EVERY First Tree bind precondition (auth, org, admin, no existing
    // binding, and the installation account) BEFORE any remote GitHub write, so a
    // logged-out / multi-org / non-admin caller — or one that would clobber an
    // existing tree or bind an uncoverable repo — fails without leaving an orphan.
    let bindContext: { serverUrl: string; accessToken: string; orgId: string } | null = null;
    let lookup: InstallationLookup | null = null;
    let installationAccount: string | null = null;
    let treeBranch = DEFAULT_BRANCH;
    if (options.bind) {
      const serverUrl = resolveServerUrl();
      const accessToken = await ensureFreshAccessToken();
      const { orgId, isAdmin } = await resolveBindContext(serverUrl, accessToken, options.org);
      if (!isAdmin) {
        throw new Error(
          `Binding the team Context Tree requires admin of org ${orgId}. Re-run with --no-bind to only create the repo, or have an admin bind it later with \`${channelConfig.binName} org bind-tree <url>\`.`,
        );
      }
      const existing = await readContextTreeBinding(serverUrl, accessToken, orgId);
      treeBranch = existing.branch;
      if (existing.repo && !options.rebind) {
        throw new Error(
          `This team is already bound to a Context Tree (${existing.repo}). \`tree init\` will not replace it — pass --rebind to intentionally replace it, or --no-bind to only create a repo.`,
        );
      }
      if (!options.rebind && !existing.supportsConditionalFinalize) {
        throw new Error(
          `Server support for conflict-safe tree init finalization is required for organization ${orgId}. Upgrade the server before retrying; no repository was created.`,
        );
      }
      lookup = await fetchInstallation(serverUrl, accessToken, orgId);
      if (lookup.kind === "error") {
        throw new Error(
          `Could not read the team's GitHub App installation to place the repo under the coverable account (server ${lookup.status || "unreachable"}). Retry, or pass --no-bind to create the repo without binding.`,
        );
      }
      // "ok" → the repo must live under the installation account; "none" (no App
      // installed yet) → fall back to the user default (an explicitly unverified repo).
      installationAccount = lookup.kind === "ok" ? lookup.data.accountLogin : null;
      bindContext = { serverUrl, accessToken, orgId };
    }

    const repoOwner = resolveRepoOwner({ optionOwner: options.owner, creatorLogin, installationAccount });
    const title = options.title?.trim() || repoOwner;
    const repoName = options.name?.trim() || defaultRepoName(title);
    const repoFullName = `${repoOwner}/${repoName}`;
    const treeRoot = resolve(process.cwd(), options.dir?.trim() || repoName);
    if (existsSync(treeRoot) && readdirSync(treeRoot).length > 0) {
      throw new Error(`Target directory is not empty: ${treeRoot}. Pass --dir to choose another path.`);
    }
    const coverage = lookup ? buildCoverage(lookup, repoFullName) : null;

    // Local scaffold + self-verify (reversible) before touching the remote — a
    // bad seed never reaches GitHub.
    mkdirSync(treeRoot, { recursive: true });
    writeScaffold(
      treeRoot,
      buildScaffoldFiles({ title, ownerLogin: creatorLogin, withWorkflow: options.withWorkflow, branch: treeBranch }),
    );
    runCommand("git", ["init", "-b", treeBranch], treeRoot);

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
    if (htmlUrl !== `https://github.com/${repoFullName}`) {
      throw new Error(`Repo created but GitHub did not confirm the expected URL for ${repoFullName}.`);
    }

    let bound = false;
    if (bindContext) {
      await bindOrgToTree({
        serverUrl: bindContext.serverUrl,
        accessToken: bindContext.accessToken,
        orgId: bindContext.orgId,
        repoUrl: htmlUrl,
        branch: treeBranch,
        rebind: options.rebind,
      });
      bound = true;
    }

    printSummary(context, {
      repo: htmlUrl,
      htmlUrl,
      owner: repoOwner,
      name: repoName,
      treeRoot,
      branch: treeBranch,
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
    .option(
      "--owner <login>",
      "GitHub owner for the repo; in the bound path defaults to the team's App installation account (must match it), otherwise the authed gh user",
    )
    .option("--name <repo>", "repository name; defaults to <team>-context-tree")
    .option("--title <team>", "team display name used in the root node title; defaults to the owner")
    .option("--public", "create a public repository (default: private)")
    .option("--dir <path>", "local directory to scaffold and push from; defaults to ./<name>")
    .option("--with-workflow", "also seed .github/workflows/validate-tree.yml (needs gh `workflow` scope)")
    .option("--no-bind", "only create the repo: skip First Tree org binding and the installation-coverage check")
    .option("--rebind", "replace an existing team Context Tree binding (default: refuse if one exists)")
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
