import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ensureMembersDomainNode,
  readMemberTemplate,
  renderInviteMemberNode,
  type MemberType,
} from "#products/tree/engine/member-seeding.js";
import { listTreeBindings } from "#products/tree/engine/runtime/binding-state.js";
import { resolveBundledPackageRoot } from "#products/tree/engine/runtime/installer.js";

export const INVITE_USAGE = `usage: first-tree tree invite --github-id <id> --type <type>
       [--title <name>] [--role <role>] [--domains <d1,d2>]
       [--delegate-mention <id>]
       [--tree-path <path>]
       [--branch | --no-branch] [--pr]

Invite a new member to the Context Tree by creating a member node with
status: invited and printing a magic word the invitee can paste into
their agent.

What it does:
  1. Creates members/<github-id>/NODE.md with status: invited
  2. Publishes the invite on a branch the invitee can fetch
  3. Optionally opens a GitHub PR for that branch
  4. Reads tree metadata to generate a context-rich invite block
  5. Prints the invite block — send it to the invitee

Options:
  --github-id <id>       GitHub username (required; becomes slug and owners value)
  --type <type>          human | personal_assistant | autonomous_agent (required)
  --title <name>         Display name (defaults to github-id)
  --role <role>          Role title (defaults to "Contributor")
  --domains <d1,d2>      Comma-separated domains (defaults to "unassigned")
  --delegate-mention <id> Personal assistant ID
  --tree-path <path>     Path to tree repo (default: current directory)
  --branch               Create invite/<github-id> branch (default)
  --no-branch            Commit on the current branch and share that branch
  --pr                   Open a GitHub PR after publishing the invite
  --help                 Show this help message
`;

const VALID_TYPES = new Set<MemberType>([
  "human",
  "personal_assistant",
  "autonomous_agent",
]);

export interface ParsedInviteArgs {
  githubId?: string;
  type?: MemberType;
  title?: string;
  role?: string;
  domains?: string[];
  delegateMention?: string;
  treePath?: string;
  branch: boolean;
  pr: boolean;
}

export function parseInviteArgs(
  args: string[],
): ParsedInviteArgs | { error: string } {
  const parsed: ParsedInviteArgs = { branch: true, pr: false };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--github-id": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --github-id" };
        parsed.githubId = val;
        break;
      }
      case "--type": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --type" };
        if (!VALID_TYPES.has(val as MemberType)) {
          return {
            error: `Invalid type '${val}' — must be one of: ${[...VALID_TYPES].sort().join(", ")}`,
          };
        }
        parsed.type = val as MemberType;
        break;
      }
      case "--title": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --title" };
        parsed.title = val;
        break;
      }
      case "--role": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --role" };
        parsed.role = val;
        break;
      }
      case "--domains": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --domains" };
        parsed.domains = val.split(",").map((d) => d.trim()).filter(Boolean);
        break;
      }
      case "--delegate-mention": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --delegate-mention" };
        parsed.delegateMention = val;
        break;
      }
      case "--tree-path": {
        const val = args[++i];
        if (!val) return { error: "Missing value for --tree-path" };
        parsed.treePath = val;
        break;
      }
      case "--branch":
        parsed.branch = true;
        break;
      case "--no-branch":
        parsed.branch = false;
        break;
      case "--pr":
        parsed.pr = true;
        break;
      default:
        return { error: `Unknown option: ${arg}` };
    }
  }

  if (!parsed.githubId) return { error: "Missing required --github-id" };
  if (!parsed.type) return { error: "Missing required --type" };

  return parsed;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getRemoteUrl(treeRoot: string): string | null {
  try {
    return git(["remote", "get-url", "origin"], treeRoot);
  } catch {
    return null;
  }
}

function getInviterName(treeRoot: string): string | null {
  try {
    return git(["config", "user.name"], treeRoot);
  } catch {
    return null;
  }
}

function getInviterGithub(treeRoot: string): string | null {
  try {
    return execFileSync("gh", ["api", "user", "-q", ".login"], {
      cwd: treeRoot,
      encoding: "utf-8",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

function getCurrentBranch(treeRoot: string): string | null {
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], treeRoot);
    return branch === "" || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

export function sanitizeInviteTreeUrl(treeUrl: string): string {
  const trimmed = treeUrl.trim();
  if (trimmed.length === 0) {
    return treeUrl;
  }

  const scpMatch = trimmed.match(
    /^(?:ssh:\/\/)?git@(?<host>[^/:]+)[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u,
  );
  if (scpMatch?.groups) {
    return `https://${scpMatch.groups.host}/${scpMatch.groups.owner}/${scpMatch.groups.repo}.git`;
  }

  try {
    const parsed = new URL(trimmed);
    const parts = parsed.pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/, "")
      .split("/");
    if (parts.length === 2 && parts.every((part) => part.trim().length > 0)) {
      return `https://${parsed.hostname}/${parts[0]}/${parts[1]}.git`;
    }
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return treeUrl;
  }
}

// --- Tree metadata extraction ---

const FRONTMATTER_RE = /^---\s*\n(.*?)\n---/s;
const TITLE_RE = /^title:\s*['"]?(.+?)['"]?\s*$/m;

export interface TreeContext {
  title: string;
  description: string;
  repositories: string[];
  inviterDisplay: string;
}

export function readTreeContext(treeRoot: string): TreeContext {
  const nodeContent = existsSync(join(treeRoot, "NODE.md"))
    ? readFileSync(join(treeRoot, "NODE.md"), "utf-8")
    : "";

  // Extract title from frontmatter
  let title = "Context Tree";
  const fmMatch = nodeContent.match(FRONTMATTER_RE);
  if (fmMatch) {
    const titleMatch = fmMatch[1].match(TITLE_RE);
    if (titleMatch) {
      title = titleMatch[1];
    }
  }

  // Extract description: first non-heading paragraph after frontmatter
  let description = "A shared organizational memory for decisions, ownership, and coordination context.";
  const body = fmMatch
    ? nodeContent.slice(fmMatch[0].length).trim()
    : nodeContent.trim();
  const paragraphs = body.split(/\n\n+/);
  for (const para of paragraphs) {
    const trimmed = para.trim();
    // Skip headings, horizontal rules, and empty lines
    if (trimmed.startsWith("#") || trimmed.startsWith("---") || trimmed.length === 0) {
      continue;
    }
    description = trimmed.replace(/\n/g, " ");
    break;
  }

  // Extract bound repositories from tree bindings
  const bindings = listTreeBindings(treeRoot);
  let repositories: string[] = bindings.map((b) => b.sourceName);

  // Fallback: extract domain names from NODE.md if no bindings
  if (repositories.length === 0) {
    const domainRe = /^\s*-\s*\*\*\[([^\]]+)\//gm;
    let match;
    while ((match = domainRe.exec(nodeContent)) !== null) {
      repositories.push(match[1]);
    }
  }

  // Inviter identity
  const ghLogin = getInviterGithub(treeRoot);
  const gitName = getInviterName(treeRoot);
  const inviterDisplay = ghLogin
    ? `@${ghLogin}`
    : gitName ?? "A team member";

  return { title, description, repositories, inviterDisplay };
}

export function composeMagicWord(
  ctx: TreeContext,
  treeUrl: string,
  githubId: string,
  branchName: string,
): string {
  const lines: string[] = [];

  lines.push("--- First Tree Invite ---");
  lines.push("");
  lines.push(`${ctx.inviterDisplay} has invited you to join a Context Tree.`);
  lines.push("");
  lines.push("## What is this tree?");
  lines.push(
    `"${ctx.title}" is a shared organizational memory.`,
  );
  lines.push(ctx.description);
  lines.push("");

  if (ctx.repositories.length > 0) {
    lines.push("## What repositories does it cover?");
    for (const repo of ctx.repositories) {
      lines.push(`  - ${repo}`);
    }
    lines.push("");
  }

  lines.push("## To accept this invite");
  lines.push(
    "Copy this entire invite and paste it into your agent.",
  );
  lines.push("");
  lines.push(
    `  npx -p first-tree first-tree tree join --tree-url ${treeUrl} --invite ${githubId} --branch ${branchName}`,
  );
  lines.push("");
  lines.push("--- End Invite ---");

  return lines.join("\n");
}

// --- Core invite logic ---

export interface InviteOptions {
  githubId: string;
  type: MemberType;
  title: string;
  role: string;
  domains: string[];
  delegateMention?: string;
  treePath: string;
  branch: boolean;
  pr: boolean;
}

export function runInvite(options: InviteOptions): number {
  const {
    githubId,
    type,
    title,
    role,
    domains,
    delegateMention,
    treePath,
    branch,
    pr,
  } = options;

  const memberDir = join(treePath, "members", githubId);
  const memberNodePath = join(memberDir, "NODE.md");
  const branchName = `invite/${githubId}`;
  const shareBranch = branch ? branchName : getCurrentBranch(treePath);

  if (shareBranch === null) {
    console.error(
      "Error: could not determine the current branch. Check out a branch first or omit --no-branch.",
    );
    return 1;
  }

  // Validate member does not already exist
  if (existsSync(memberDir)) {
    console.error(
      `Error: members/${githubId}/ already exists in the tree. Cannot invite an existing member.`,
    );
    return 1;
  }

  // Validate branch does not already exist
  if (branch) {
    try {
      git(["rev-parse", "--verify", branchName], treePath);
      console.error(
        `Error: branch '${branchName}' already exists. Delete or rename it before re-inviting.`,
      );
      return 1;
    } catch {
      // Branch does not exist — good
    }
  }

  // Ensure members/NODE.md exists
  const packageRoot = resolveBundledPackageRoot();
  const frameworkRoot = join(packageRoot, "assets", "tree");
  ensureMembersDomainNode(treePath, treePath, frameworkRoot);

  // Read and render template
  const template = readMemberTemplate(treePath, treePath, frameworkRoot);
  const rendered = renderInviteMemberNode(template, {
    githubId,
    title,
    type,
    role,
    domains,
    delegateMention,
  });

  // Create branch if requested
  if (branch) {
    git(["checkout", "-b", branchName], treePath);
  }

  // Write member node
  mkdirSync(memberDir, { recursive: true });
  writeFileSync(memberNodePath, rendered);

  // Commit
  git(["add", join("members", githubId, "NODE.md")], treePath);
  git(
    ["commit", "-m", `docs(members): invite ${githubId}`],
    treePath,
  );

  console.log(`\nInvite created for ${githubId}`);

  try {
    git(["push", "-u", "origin", shareBranch], treePath);
    console.log(`  Published invite on origin/${shareBranch}`);
  } catch (err) {
    console.error(
      `Error: could not publish branch '${shareBranch}'. Push it manually before sharing the invite.\n${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }

  // PR
  if (pr) {
    try {
      execFileSync(
        "gh",
        [
          "pr",
          "create",
          "--title",
          `docs(members): invite ${githubId}`,
          "--body",
          `Invite ${title} (@${githubId}) to join the Context Tree as ${type}.\n\nRole: ${role}\nDomains: ${domains.join(", ")}`,
        ],
        {
          cwd: treePath,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      console.log(`  PR created on branch ${branchName}`);
    } catch (err) {
      console.error(
        `  Warning: could not create PR — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Generate and print magic word
  const remoteUrl = getRemoteUrl(treePath);
  if (remoteUrl) {
    const ctx = readTreeContext(treePath);
    const magicWord = composeMagicWord(
      ctx,
      sanitizeInviteTreeUrl(remoteUrl),
      githubId,
      shareBranch,
    );
    console.log("\n" + "=".repeat(50));
    console.log("Copy the ENTIRE block below and send it to the invitee.");
    console.log("They should paste the whole thing into their agent.");
    console.log("=".repeat(50) + "\n");
    console.log(magicWord);
    console.log("\n" + "=".repeat(50));
  } else {
    console.log(
      "\nThe tree repo has no remote. Share the local path with the invitee manually.",
    );
  }

  return 0;
}

export function runInviteCli(args: string[] = []): number {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(INVITE_USAGE);
    return 0;
  }

  const parsed = parseInviteArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    console.log(INVITE_USAGE);
    return 1;
  }

  const treePath = parsed.treePath
    ? resolve(process.cwd(), parsed.treePath)
    : process.cwd();

  return runInvite({
    githubId: parsed.githubId!,
    type: parsed.type!,
    title: parsed.title ?? parsed.githubId!,
    role: parsed.role ?? "Contributor",
    domains: parsed.domains ?? ["unassigned"],
    delegateMention: parsed.delegateMention,
    treePath,
    branch: parsed.branch,
    pr: parsed.pr,
  });
}
