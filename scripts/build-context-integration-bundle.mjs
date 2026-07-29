#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXTERNAL_SKILLS = ["first-tree-read", "first-tree-write"];
const PLUGIN_NAME = "first-tree-context";
const PROVIDERS = ["claude-code", "codex"];

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(
        "Usage: build-context-integration-bundle.mjs [--out-dir <path>] [--version <semver>] [--channel <prod|staging|dev>]",
      );
    }
    args.set(key, value);
  }
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "apps", "cli", "package.json"), "utf8"));
  const buildInfo = readFileSync(join(REPO_ROOT, "apps", "cli", "src", "build-info.ts"), "utf8");
  const sourceChannel = buildInfo.match(/CHANNEL: ChannelName = "(prod|staging|dev)"/)?.[1];
  if (!sourceChannel) throw new Error("Unable to resolve the CLI release channel from apps/cli/src/build-info.ts.");
  return {
    outDir: resolve(args.get("--out-dir") ?? join(REPO_ROOT, "apps", "cli", "context-integration")),
    version: args.get("--version") ?? packageJson.version,
    channel: args.get("--channel") ?? sourceChannel,
  };
}

function sha256(content) {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function normalizedFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(path);
      } else {
        throw new Error(`Bundle source contains an unsupported entry: ${path}`);
      }
    }
  };
  visit(root);
  return files;
}

function treeDigest(root, filter = () => true) {
  const hash = createHash("sha256");
  for (const path of normalizedFiles(root)) {
    const name = relative(root, path).split("\\").join("/");
    if (!filter(name)) continue;
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceRequired(content, search, replacement, label) {
  if (!content.includes(search)) throw new Error(`External Skill projection marker is missing: ${label}`);
  return content.replace(search, replacement);
}

function replaceRequiredPattern(content, pattern, replacement, label) {
  const matches = content.match(pattern);
  if (!matches || matches.length !== 1) {
    throw new Error(`External Skill projection marker must match exactly once: ${label}`);
  }
  return content.replace(pattern, replacement);
}

function projectExternalSkill(name, sourceContent, provider) {
  let content = sourceContent;
  const providerOption = `--provider ${provider}`;
  const boundary = [
    "",
    "## External Plugin Activation Boundary",
    "",
    `This is the **${provider} user-scope Plugin projection**. Its activation`,
    "boundary is mandatory for every operation:",
    "",
    "- Never accept a Team id from model context, a user prompt, Web state, or a prior task.",
    "- Never call the generic Team-parameter Tree commands from this Plugin.",
    "- Use only the hidden `context read` / `context write` route shown below. It derives",
    "  Team from the exact provider + checkout binding, repeats live membership and",
    "  selected-Team repository-scope validation, then delegates to the generic Tree",
    "  operation. Missing binding, repository drift, Server failure, or denied activation",
    "  stops before Tree content or mutation authority is returned.",
    "- Capture the original source checkout before entering a Tree snapshot/worktree,",
    "  and run every hidden route with that source checkout as its process cwd. A Tree",
    "  snapshot or authoring worktree is never the activation checkout.",
    "- Re-run `context write` immediately before every push and PR/MR creation; a",
    "  SessionStart Connected envelope is not mutation authority.",
    "",
  ].join("\n");
  const frontmatterEnd = content.indexOf("\n---", 4);
  if (frontmatterEnd < 0) throw new Error(`External Skill source has invalid frontmatter: ${name}`);
  const insertAt = frontmatterEnd + 4;
  content = `${content.slice(0, insertAt)}${boundary}${content.slice(insertAt)}`;

  if (name === "first-tree-read") {
    content = replaceRequired(
      content,
      `Apply the generated Context Tree Policy's content classes and drift-authority
rules before treating a file as current truth.`,
      `Before any activation or Tree operation, read
\`references/context-tree-policy.md\` completely, resolving the path relative
to this Skill directory. This is the canonical Context Tree Policy shared by
managed First Tree briefings and external provider Plugins. If that file is
missing or unreadable, fail closed before reading Tree content; do not rely on
a remembered or copied policy.

Apply that Policy's content classes and drift-authority rules before treating a
file as current truth.`,
      `${name} lazy Policy`,
    );
    content = replaceRequiredPattern(
      content,
      /^description: .+$/mu,
      `description: Read the current repo's Context Tree through the ${provider} user-scope Plugin. Requires an exact provider + checkout binding created by a Team-scoped enable handoff and live activation; never accepts a Team id from the model or user.`,
      `${name} description`,
    );
    content = replaceRequired(
      content,
      `Use the **BYO task snapshot** path only when the task handoff or user input
names an explicit First Tree Team id. The Team id is required task input: do
not infer it from a Web selection, \`/me\` default, cached role, prior task, or
account-global current state. If a BYO Read is requested without that explicit
Team id, stop before reading Tree content and request it.`,
      `In this External Plugin projection, always use the exact checkout activation
route. The Team is derived only from the current ${provider} + checkout binding
and live Server validation. Do not ask for, accept, or forward a Team id.`,
      `${name} activation mode`,
    );
    content = replaceRequired(
      content,
      `Otherwise retain the **managed workspace** path below. A workspace manifest is
the managed compatibility anchor; its presence is not a substitute for an
explicit Team in the BYO path.

### 2A. Activate one BYO task snapshot`,
      "### 2. Activate one External Plugin task snapshot",
      `${name} external-only path`,
    );
    content = replaceRequired(
      content,
      `first-tree tree read --help
byo_read_root="$(mktemp -d)"
first-tree --json tree read --team "<team-id>" --snapshot "$byo_read_root/context-tree"`,
      `first_tree_source_checkout="$(git rev-parse --show-toplevel)"
first-tree context read ${providerOption} --help
byo_read_root="$(mktemp -d)"
(cd "$first_tree_source_checkout" && \\
  first-tree --json context read ${providerOption} --snapshot "$byo_read_root/context-tree")`,
      `${name} command`,
    );
    content = replaceRequiredPattern(
      content,
      /### 2B\. Resolve the managed workspace context repo[\s\S]*?(?=### 3\. Inspect the managed reader command every time)/u,
      "",
      `${name} managed fallback`,
    );
    content = replaceRequired(
      content,
      "### 3. Inspect the managed reader command every time",
      "### 3. Inspect the snapshot reader command every time",
      `${name} reader heading`,
    );
    content = replaceRequired(
      content,
      `- For a BYO task, include \`--no-pull\` on every selector and keep every selected
  path inside the activated snapshot. For a managed workspace, retain the
  command's existing pull-before-selector behavior.`,
      `- Include \`--no-pull\` on every selector and keep every selected path inside
  the activated snapshot.`,
      `${name} selector boundary`,
    );
    content = replaceRequired(
      content,
      "  explicitly requires a workspace-wide read.",
      "  explicitly requires a broad tree read.",
      `${name} broad read wording`,
    );
    content = replaceRequiredPattern(
      content,
      /For a BYO task, use the activation receipt's binding repository and commit\.[\s\S]*?(?=The receipt is the agent's durable, reviewable attribution\.)/u,
      `Use the activation receipt's binding repository and commit. Its detached
snapshot is already exact and remote-backed. Record only evidence that exists
unchanged in that snapshot. Never substitute another checkout, branch, remote,
or remembered Team identity.

`,
      `${name} receipt authority`,
    );
    content = content
      .replace("A BYO task first", "An External Plugin task first")
      .replace("fall back to a managed workspace clone", "fall back to another checkout or cached clone")
      .replace(
        "as the Server activation receipt or managed workspace briefing declares it;",
        "exactly as the Server activation receipt declares it;",
      )
      .replace("- for BYO Read, report", "- for External Plugin Read, report");
  } else {
    content = replaceRequired(
      content,
      `Use this skill when a specific source artifact should be reflected into the
Context Tree. The generated \`AGENTS.md\` / \`CLAUDE.md\` Context Tree Policy is
the baseline for what belongs in the tree; this skill applies that policy to a
source-backed write.`,
      `Use this skill when a specific source artifact should be reflected into the
Context Tree. Before any activation, target selection, or Tree operation, read
\`references/context-tree-policy.md\` completely, resolving the path relative
to this Skill directory. This is the canonical Context Tree Policy shared by
managed First Tree briefings and external provider Plugins. If that file is
missing or unreadable, fail closed before reading or mutating Tree content; do
not rely on a remembered or copied policy. This skill applies that policy to a
source-backed write.`,
      `${name} lazy Policy`,
    );
    content = replaceRequiredPattern(
      content,
      /^description: .+$/mu,
      `description: Source-driven Context Tree write workflow for the ${provider} user-scope Plugin. Requires an exact provider + checkout binding, a Plugin-created exact read snapshot, live write preflight, a concrete source artifact, and write intent; never accepts a Team id from the model or user.`,
      `${name} description`,
    );
    content = replaceRequired(
      content,
      `- **Managed:** use the generated workspace binding and briefing when present;
  the source gate and write policy below remain unchanged.
`,
      "",
      `${name} managed mode`,
    );
    content = replaceRequired(
      content,
      `- **BYO clean (GitHub- or GitLab-bound Context Trees):** require the user's explicit Team id, the existing exact
  snapshot created by \`tree read\`, a concrete source artifact and revision,
  current source context, current target/parent/linked tree context, and the
  user's write intent. Do not require or reconstruct a Workspace manifest,
  managed briefing, setup-chat transcript, Web selection, default/current
  Team, cached owner/role, or prior task.`,
      `- **External Plugin (${provider}):** require the existing exact snapshot created
  by this Plugin's \`context read\` route, a concrete source artifact and
  revision, current source/target context, and write intent. Team is derived
  only from the current provider + checkout binding and live validation; never
  accept it as model/user input or reconstruct it from other state.`,
      `${name} invocation mode`,
    );
    content = replaceRequired(
      content,
      `first-tree --json tree write --team "<team-id>" \\
  --snapshot "<exact-snapshot>" --github-login "<gh-login>"`,
      `(cd "<original-source-checkout>" && \\
  first-tree --json context write ${providerOption} \\
    --snapshot "<exact-snapshot>" --github-login "<gh-login>")`,
      `${name} GitHub command`,
    );
    content = replaceRequired(
      content,
      `first-tree --json tree write --team "<team-id>" \\
  --snapshot "<exact-snapshot>"`,
      `(cd "<original-source-checkout>" && \\
  first-tree --json context write ${providerOption} \\
    --snapshot "<exact-snapshot>")`,
      `${name} GitLab command`,
    );
    content = replaceRequired(
      content,
      "Clean BYO Write preflight returns the live provider and binding.",
      "External Plugin Write preflight returns the live provider and exact binding-derived Team.",
      `${name} preflight wording`,
    );
    content = replaceRequired(
      content,
      "This stateless command verifies the snapshot identity, explicit Team, live",
      "This command verifies the snapshot identity, exact binding-derived Team, live",
      `${name} authority wording`,
    );
    content = replaceRequired(content, "In BYO mode,", "In External Plugin mode,", `${name} snapshot wording`);
    content = replaceRequired(
      content,
      `- \`first-tree tree write\` — in BYO mode, revalidate one explicit Team and
  exact snapshot and provider authentication before mutation.`,
      `- \`first-tree context write ${providerOption}\` — revalidate the current
  provider + checkout binding, live Team scope, exact snapshot, Reviewer
  readiness, and provider authentication before mutation.`,
      `${name} CLI reference`,
    );
  }
  const forbidden = [
    /tree (?:read|write) --team/u,
    /request (?:an explicit |it from the user|the )?Team id/iu,
    /Resolve the managed workspace/u,
    /\*\*Managed:\*\*/u,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      throw new Error(`External ${provider} ${name} still exposes a forbidden generic activation path: ${pattern}`);
    }
  }
  return content;
}

function copyExternalSkills(pluginRoot, provider) {
  const target = join(pluginRoot, "skills");
  mkdirSync(target, { recursive: true });
  for (const name of EXTERNAL_SKILLS) {
    const source = join(REPO_ROOT, "skills", name);
    if (!existsSync(join(source, "SKILL.md"))) throw new Error(`External Skill source is missing: ${source}`);
    const skillTarget = join(target, name);
    cpSync(source, skillTarget, { recursive: true });
    const skillPath = join(skillTarget, "SKILL.md");
    const externalSkill = projectExternalSkill(name, readFileSync(skillPath, "utf8"), provider);
    writeFileSync(skillPath, externalSkill);
    mkdirSync(join(skillTarget, "references"), { recursive: true });
    cpSync(
      join(REPO_ROOT, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"),
      join(skillTarget, "references", "context-tree-policy.md"),
    );
  }
}

function writeSessionStartHook(pluginRoot, provider) {
  const binDir = join(pluginRoot, "bin");
  mkdirSync(binDir, { recursive: true });
  const script = join(binDir, "context-session-start");
  writeFileSync(
    script,
    ["#!/bin/sh", "set -eu", `exec __FIRST_TREE_INVOCATION__ context activate --provider ${provider} "$@"`, ""].join(
      "\n",
    ),
  );
  chmodSync(script, 0o755);

  writeJson(join(pluginRoot, "hooks", "hooks.json"), {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear|compact",
          hooks: [
            {
              type: "command",
              command:
                provider === "codex"
                  ? `"\${PLUGIN_ROOT}/bin/context-session-start" --release-digest __RELEASE_DIGEST__`
                  : `"\${CLAUDE_PLUGIN_ROOT}/bin/context-session-start" --release-digest __RELEASE_DIGEST__`,
              timeout: 5,
              statusMessage: "Connecting First Tree Context",
              additionalContextLimit: 2048,
            },
          ],
        },
      ],
    },
  });
}

function writeClaudeBundle(providerRoot, version, marketplaceName) {
  const pluginRoot = join(providerRoot, "plugins", PLUGIN_NAME);
  copyExternalSkills(pluginRoot, "claude-code");
  writeSessionStartHook(pluginRoot, "claude-code");
  writeJson(join(pluginRoot, ".claude-plugin", "plugin.json"), {
    name: PLUGIN_NAME,
    version,
    description: "Use explicit-Team First Tree Context in Claude Code without joining the First Tree Agent runtime.",
    author: { name: "First Tree" },
    homepage: "https://first-tree.ai",
    repository: "https://github.com/agent-team-foundation/first-tree",
    license: "Apache-2.0",
    skills: "./skills/",
  });
  writeJson(join(providerRoot, ".claude-plugin", "marketplace.json"), {
    name: marketplaceName,
    owner: { name: "First Tree" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: "./plugins/first-tree-context",
        description: "Read and update explicit-Team First Tree Context from Claude Code.",
        version,
      },
    ],
  });
  return pluginRoot;
}

function writeCodexBundle(providerRoot, version, marketplaceName) {
  const pluginRoot = join(providerRoot, "plugins", PLUGIN_NAME);
  copyExternalSkills(pluginRoot, "codex");
  writeSessionStartHook(pluginRoot, "codex");
  writeJson(join(pluginRoot, ".codex-plugin", "plugin.json"), {
    name: PLUGIN_NAME,
    version,
    description: "Use explicit-Team First Tree Context in Codex without joining the First Tree Agent runtime.",
    author: { name: "First Tree", url: "https://first-tree.ai" },
    homepage: "https://first-tree.ai",
    repository: "https://github.com/agent-team-foundation/first-tree",
    license: "Apache-2.0",
    keywords: ["context-tree", "team-context", "coding-agent"],
    skills: "./skills/",
    interface: {
      displayName: "First Tree Context",
      shortDescription: "Bring explicit-Team Context Tree decisions into Codex.",
      longDescription:
        "Read and propose source-backed updates to the Context Tree selected by an explicit First Tree Team handoff.",
      developerName: "First Tree",
      category: "Developer Tools",
      capabilities: ["Read team Context Tree", "Propose source-backed Context Tree updates"],
      websiteURL: "https://first-tree.ai",
      defaultPrompt: [
        "Read the relevant First Tree Context before working on this repository.",
        "Reflect this source-backed decision into the First Tree Context Tree.",
      ],
    },
  });
  writeJson(join(providerRoot, ".agents", "plugins", "marketplace.json"), {
    name: marketplaceName,
    interface: { displayName: "First Tree" },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "local", path: "./plugins/first-tree-context" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
        interface: { displayName: "First Tree Context" },
      },
    ],
  });
  return pluginRoot;
}

export function buildContextIntegrationBundle(rawOptions) {
  const options = {
    ...rawOptions,
    outDir: resolve(rawOptions.outDir),
  };
  if (!["prod", "staging", "dev"].includes(options.channel)) {
    throw new Error(`Unsupported context integration channel: ${options.channel}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(options.version)) {
    throw new Error(`Context integration version must be SemVer: ${options.version}`);
  }

  rmSync(options.outDir, { recursive: true, force: true });
  mkdirSync(options.outDir, { recursive: true });

  const marketplaceName = options.channel === "prod" ? "first-tree" : `first-tree-${options.channel}`;
  const pluginRoots = {
    "claude-code": writeClaudeBundle(join(options.outDir, "claude-code"), options.version, marketplaceName),
    codex: writeCodexBundle(join(options.outDir, "codex"), options.version, marketplaceName),
  };
  const policy = readFileSync(
    join(REPO_ROOT, "packages", "client", "src", "runtime", "assets", "context-tree-policy.md"),
  );
  const policyDigest = sha256(policy);
  const providers = Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider,
      {
        adapterDigest: treeDigest(pluginRoots[provider]),
        minimumVersion: provider === "claude-code" ? "2.1.121" : "0.144.0",
      },
    ]),
  );
  const bundleDigest = sha256(
    Buffer.from(
      JSON.stringify({
        policyDigest,
        providers: PROVIDERS.map((provider) => [provider, providers[provider].adapterDigest]),
      }),
    ),
  );
  const manifest = {
    schemaVersion: 1,
    version: options.version,
    channel: options.channel,
    bundleDigest,
    policyDigest,
    providers,
  };
  writeJson(join(options.outDir, "release-manifest.json"), manifest);
  return { manifest, pluginRoots };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const { manifest } = buildContextIntegrationBundle(options);
  process.stdout.write(
    `build-context-integration-bundle: ${manifest.channel} ${manifest.version} ${manifest.bundleDigest}\n`,
  );
}
