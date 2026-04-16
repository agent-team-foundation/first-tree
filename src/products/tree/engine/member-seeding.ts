import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  frameworkTemplateDirCandidates,
  resolveFirstExistingPath,
} from "#products/tree/engine/runtime/asset-loader.js";

export type SeededContributorType = "autonomous_agent" | "human";

export interface SeededContributor {
  contributions?: number;
  owner: string;
  role: string;
  slug: string;
  source: "github" | "git";
  title: string;
  type: SeededContributorType;
}

export interface CollectContributorMembersResult {
  contributors: SeededContributor[];
  notice?: string;
  source: "github" | "git" | "none";
}

export interface SeedMembersResult extends CollectContributorMembersResult {
  created: number;
  skipped: number;
}

type ExecRunner = (
  command: string,
  args: string[],
  options: { cwd: string },
) => string;

interface GitHubRemote {
  host: string;
  owner: string;
  repo: string;
}

interface GitHubContributor {
  contributions?: number;
  email?: string | null;
  login?: string | null;
  name?: string | null;
  type?: string | null;
}

export type ContributorCollector = (
  repoRoot: string,
) => CollectContributorMembersResult;

function defaultExecRunner(
  command: string,
  args: string[],
  options: { cwd: string },
): string {
  return execFileSync(command, args, {
    cwd: options.cwd,
    encoding: "utf-8",
  }).trim();
}

function normalizeSlug(value: string | null | undefined): string | null {
  if (!value) return null;
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug : null;
}

function deriveOwnerFromEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (trimmed.length === 0 || !trimmed.includes("@")) {
    return null;
  }

  const local = trimmed.split("@", 1)[0] ?? "";
  const withoutPlus = local.includes("+")
    ? local.split("+").pop() ?? local
    : local;
  return normalizeSlug(withoutPlus);
}

function detectBot(...parts: Array<string | null | undefined>): boolean {
  const raw = parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .toLowerCase();
  const normalized = raw.replace(/[^a-z0-9]+/g, " ");
  return (
    raw.includes("[bot]")
    || normalized.includes("dependabot")
    || normalized.includes("renovate")
    || normalized.includes("github actions")
    || normalized.includes("github action")
    || /\bbot\b/.test(normalized)
  );
}

function toSeededContributor(input: {
  contributions?: number;
  email?: string | null;
  login?: string | null;
  name?: string | null;
  source: "github" | "git";
  typeHint?: string | null;
}): SeededContributor | null {
  const owner =
    normalizeSlug(input.login)
    ?? deriveOwnerFromEmail(input.email)
    ?? normalizeSlug(input.name);
  if (owner === null) {
    return null;
  }

  const isBot = detectBot(
    input.login,
    input.name,
    input.email,
    input.typeHint,
  );

  return {
    contributions: input.contributions,
    owner,
    role: isBot ? "Automation Contributor" : "Contributor",
    slug: owner,
    source: input.source,
    title: input.name?.trim() || input.login?.trim() || owner,
    type: isBot ? "autonomous_agent" : "human",
  };
}

function sortContributors(contributors: SeededContributor[]): SeededContributor[] {
  return [...contributors].sort((a, b) => {
    const contributionDelta = (b.contributions ?? 0) - (a.contributions ?? 0);
    if (contributionDelta !== 0) {
      return contributionDelta;
    }
    return a.slug.localeCompare(b.slug);
  });
}

function dedupeContributors(
  contributors: SeededContributor[],
): SeededContributor[] {
  const bySlug = new Map<string, SeededContributor>();

  for (const contributor of contributors) {
    const key = contributor.slug;
    const existing = bySlug.get(key);
    if (!existing) {
      bySlug.set(key, { ...contributor });
      continue;
    }

    existing.contributions = (existing.contributions ?? 0) + (contributor.contributions ?? 0);
    if (existing.title === existing.owner && contributor.title !== contributor.owner) {
      existing.title = contributor.title;
    }
    if (existing.type !== "autonomous_agent" && contributor.type === "autonomous_agent") {
      existing.type = contributor.type;
      existing.role = contributor.role;
    }
  }

  return sortContributors([...bySlug.values()]);
}

export function parseGitHubRemoteUrl(remoteUrl: string): GitHubRemote | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const patterns = [
    /^(?:https?:\/\/)(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/u,
    /^(?:ssh:\/\/)?git@(?<host>[^/:]+)[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match?.groups) {
      continue;
    }
    return {
      host: match.groups.host,
      owner: match.groups.owner,
      repo: match.groups.repo,
    };
  }

  return null;
}

function readOriginRemoteUrl(
  repoRoot: string,
  execRunner: ExecRunner,
): string | null {
  try {
    return execRunner("git", ["remote", "get-url", "origin"], {
      cwd: repoRoot,
    });
  } catch {
    return null;
  }
}

export function collectGitHubContributorMembers(
  repoRoot: string,
  execRunner: ExecRunner = defaultExecRunner,
): CollectContributorMembersResult {
  const remoteUrl = readOriginRemoteUrl(repoRoot, execRunner);
  if (remoteUrl === null) {
    return {
      contributors: [],
      notice: "No origin remote was found, so contributor seeding used local git history instead.",
      source: "none",
    };
  }

  const remote = parseGitHubRemoteUrl(remoteUrl);
  if (remote === null) {
    return {
      contributors: [],
      notice: "The origin remote is not a GitHub-style URL, so contributor seeding used local git history instead.",
      source: "none",
    };
  }

  try {
    const raw = execRunner(
      "gh",
      [
        "api",
        "--hostname",
        remote.host,
        "--paginate",
        "--slurp",
        `repos/${remote.owner}/${remote.repo}/contributors?per_page=100&anon=1`,
      ],
      { cwd: repoRoot },
    );

    const pages = JSON.parse(raw) as GitHubContributor[][];
    const contributors = dedupeContributors(
      pages
        .flat()
        .map((contributor) =>
          toSeededContributor({
            contributions: contributor.contributions,
            email: contributor.email,
            login: contributor.login,
            name: contributor.name,
            source: "github",
            typeHint: contributor.type,
          }))
        .filter((contributor): contributor is SeededContributor => contributor !== null),
    );

    return {
      contributors,
      source: contributors.length > 0 ? "github" : "none",
    };
  } catch {
    return {
      contributors: [],
      notice: "GitHub contributor lookup was unavailable, so contributor seeding used local git history instead.",
      source: "none",
    };
  }
}

export function parseGitShortlog(raw: string): SeededContributor[] {
  const contributors: SeededContributor[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const withEmail = line.match(/^\s*(\d+)\s+(.+?)\s+<([^>]+)>\s*$/u);
    if (withEmail) {
      const contributor = toSeededContributor({
        contributions: Number.parseInt(withEmail[1] ?? "0", 10),
        email: withEmail[3],
        name: withEmail[2],
        source: "git",
      });
      if (contributor) {
        contributors.push(contributor);
      }
      continue;
    }

    const withoutEmail = line.match(/^\s*(\d+)\s+(.+?)\s*$/u);
    if (!withoutEmail) {
      continue;
    }

    const contributor = toSeededContributor({
      contributions: Number.parseInt(withoutEmail[1] ?? "0", 10),
      name: withoutEmail[2],
      source: "git",
    });
    if (contributor) {
      contributors.push(contributor);
    }
  }

  return dedupeContributors(contributors);
}

export function collectGitHistoryContributorMembers(
  repoRoot: string,
  execRunner: ExecRunner = defaultExecRunner,
): CollectContributorMembersResult {
  try {
    const raw = execRunner(
      "git",
      ["shortlog", "-se", "--all", "--no-merges"],
      { cwd: repoRoot },
    );
    const contributors = parseGitShortlog(raw);
    return {
      contributors,
      source: contributors.length > 0 ? "git" : "none",
    };
  } catch {
    return {
      contributors: [],
      source: "none",
    };
  }
}

export function collectContributorMembers(
  repoRoot: string,
  execRunner: ExecRunner = defaultExecRunner,
): CollectContributorMembersResult {
  const github = collectGitHubContributorMembers(repoRoot, execRunner);
  if (github.contributors.length > 0) {
    return github;
  }

  const git = collectGitHistoryContributorMembers(repoRoot, execRunner);
  if (git.notice || github.notice) {
    return {
      ...git,
      notice: github.notice ?? git.notice,
    };
  }
  return git;
}

export function escapeYamlDoubleQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function locateTemplatePath(
  roots: string[],
  templateName: string,
  frameworkRoot?: string,
): string {
  if (frameworkRoot) {
    const direct = join(frameworkRoot, "templates", templateName);
    if (existsSync(direct)) {
      return direct;
    }
  }
  for (const root of roots) {
    const relPath = resolveFirstExistingPath(
      root,
      frameworkTemplateDirCandidates().map((candidate) => join(candidate, templateName)),
    );
    if (relPath !== null) {
      return join(root, relPath);
    }
  }

  throw new Error(
    `Could not locate ${templateName} in the installed first-tree framework.`,
  );
}

export function ensureMembersDomainNode(
  sourceRepoRoot: string,
  treeRoot: string,
  frameworkRoot?: string,
): void {
  const membersDir = join(treeRoot, "members");
  const membersNodePath = join(membersDir, "NODE.md");
  if (existsSync(membersNodePath)) {
    return;
  }

  mkdirSync(membersDir, { recursive: true });
  copyFileSync(
    locateTemplatePath([treeRoot, sourceRepoRoot], "members-domain.md.template", frameworkRoot),
    membersNodePath,
  );
}

export function readMemberTemplate(
  sourceRepoRoot: string,
  treeRoot: string,
  frameworkRoot?: string,
): string {
  return readFileSync(
    locateTemplatePath([treeRoot, sourceRepoRoot], "member-node.md.template", frameworkRoot),
    "utf-8",
  );
}

function renderMemberNode(
  template: string,
  contributor: SeededContributor,
): string {
  const sourceLabel = contributor.source === "github"
    ? "GitHub"
    : "git";
  const aboutText =
    `Seeded from ${sourceLabel} contributor history during \`first-tree init\`. ` +
    "Review this node, remove stale contributors, and replace the placeholder role and domains with current ownership.";
  const focusText = contributor.type === "autonomous_agent"
    ? "Review the automation scope and current ownership before relying on this node."
    : "Review the contributor's current focus and ownership before relying on this node.";

  return template
    .replace(
      'title: "<Display Name>"',
      `title: "${escapeYamlDoubleQuoted(contributor.title)}"`,
    )
    .replace(
      "owners: [<github-username>]",
      `owners: [${contributor.owner}]`,
    )
    .replace(
      'type: "<human | personal_assistant | autonomous_agent>"',
      `type: "${contributor.type}"`,
    )
    .replace(
      'role: "<role title>"',
      `role: "${escapeYamlDoubleQuoted(contributor.role)}"`,
    )
    .replace(
      '  - "<domain>"',
      `  - "${contributor.type === "autonomous_agent" ? "automation" : "unassigned"}"`,
    )
    .replace('# <Display Name>', `# ${contributor.title}`)
    .replace(
      "<!-- Who you are and what you bring to the team. -->",
      aboutText,
    )
    .replace(
      "<!-- What you're actively working on. -->",
      focusText,
    );
}

export type MemberType = "human" | "personal_assistant" | "autonomous_agent";

export interface InviteMemberInput {
  githubId: string;
  title: string;
  type: MemberType;
  role: string;
  domains: string[];
  delegateMention?: string;
}

export function renderInviteMemberNode(
  template: string,
  input: InviteMemberInput,
): string {
  const domainsYaml = input.domains
    .map((d) => `  - "${escapeYamlDoubleQuoted(d)}"`)
    .join("\n");

  const delegateLine = input.delegateMention
    ? `\ndelegate_mention: "${escapeYamlDoubleQuoted(input.delegateMention)}"`
    : "";

  return template
    .replace(
      'title: "<Display Name>"',
      `title: "${escapeYamlDoubleQuoted(input.title)}"`,
    )
    .replace(
      "owners: [<github-username>]",
      `owners: [${input.githubId}]`,
    )
    .replace(
      'type: "<human | personal_assistant | autonomous_agent>"',
      `type: "${input.type}"\nstatus: "invited"${delegateLine}`,
    )
    .replace(
      'role: "<role title>"',
      `role: "${escapeYamlDoubleQuoted(input.role)}"`,
    )
    .replace(
      '  - "<domain>"',
      domainsYaml,
    )
    .replace('# <Display Name>', `# ${input.title}`);
}

function collectExistingMemberNames(root: string): Set<string> {
  const names = new Set<string>();
  if (!existsSync(root)) {
    return names;
  }

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const childPath = join(dir, entry);
      let stats;
      try {
        stats = statSync(childPath);
      } catch {
        continue;
      }
      if (!stats.isDirectory()) {
        continue;
      }
      names.add(entry);
      walk(childPath);
    }
  };

  walk(root);
  return names;
}

export function seedMembersFromContributors(
  sourceRepoRoot: string,
  treeRoot: string,
  collectContributors: ContributorCollector = collectContributorMembers,
  frameworkRoot?: string,
): SeedMembersResult {
  const collected = collectContributors(sourceRepoRoot);
  if (collected.contributors.length === 0) {
    return {
      ...collected,
      created: 0,
      skipped: 0,
    };
  }

  ensureMembersDomainNode(sourceRepoRoot, treeRoot, frameworkRoot);
  const template = readMemberTemplate(sourceRepoRoot, treeRoot, frameworkRoot);
  const membersDir = join(treeRoot, "members");
  const existingNames = collectExistingMemberNames(membersDir);
  let created = 0;
  let skipped = 0;

  for (const contributor of collected.contributors) {
    if (existingNames.has(contributor.slug)) {
      skipped += 1;
      continue;
    }

    const memberDir = join(membersDir, contributor.slug);
    const memberNodePath = join(memberDir, "NODE.md");
    mkdirSync(dirname(memberNodePath), { recursive: true });
    writeFileSync(memberNodePath, renderMemberNode(template, contributor));
    existingNames.add(contributor.slug);
    created += 1;
  }

  return {
    ...collected,
    created,
    skipped,
  };
}
