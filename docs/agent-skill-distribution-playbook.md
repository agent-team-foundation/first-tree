<!-- markdownlint-disable MD013 -->

# Agent Skill Distribution Playbook

[中文版本](agent-skill-distribution-playbook.zh-CN.md)

- **Revision:** 1.0
- **Date:** 2026-07-16
- **Audience:** Product teams, skill authors, agent-runtime maintainers,
  security reviewers, and release engineers

## Purpose

This playbook defines how to turn an agent capability into a discoverable,
installable, verifiable, maintainable, and removable product surface.

Its central principle is:

> `SKILL.md` is a capability contract and bootstrap entry point. It is not a
> package manager, a security boundary, or a substitute for a deterministic
> execution interface.

A complete distribution path is:

```text
discover -> inspect -> authorize -> install -> verify -> register
         -> activate -> execute -> update or uninstall
```

The path must work for both audiences:

- A person needs one understandable entry point, a clear trust decision, and a
  predictable result.
- An agent needs machine-readable routing metadata, explicit procedures,
  deterministic tools, actionable errors, and validation steps.

This playbook uses **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and
**MAY** as normative requirement levels.

## Scope

This playbook covers:

- individual Agent Skills;
- skills backed by scripts, CLIs, MCP servers, or APIs;
- plugin or marketplace bundles containing multiple skills;
- project-, user-, organization-, and runtime-managed installation scopes;
- discovery, activation, security, versioning, updates, rollback, and removal;
- deterministic checks and model-based routing evaluations.

It does not define:

- a universal skill registry or package manager;
- a universal dependency or lockfile format;
- a replacement for application documentation;
- a reason to turn always-on policy into an on-demand skill;
- permission to execute instructions from an untrusted repository.

## 1. Choose the delivery shape first

Do not begin by writing `SKILL.md`. Begin by classifying the capability.

| Capability | Recommended delivery shape | Reason |
| --- | --- | --- |
| Domain knowledge, review criteria, or a repeatable procedure | `SKILL.md` plus focused references | The model can perform the work once it receives the right context. |
| Deterministic local transformation or validation | `SKILL.md` plus scripts or a CLI | Code should own repeatability, parsing, and exact outputs. |
| Remote service, credentials, or durable external state | `SKILL.md` plus MCP or API integration | The execution boundary needs explicit authentication and typed operations. |
| Several related capabilities with shared dependencies or release cadence | Plugin or marketplace bundle containing skills | The bundle owns installation, compatibility, and coordinated updates. |
| Team-wide rules that must apply on every task | Runtime briefing, policy, or system configuration | An on-demand skill can fail to activate and is the wrong enforcement layer. |
| Human-facing product with no agent-specific workflow | Normal application and product documentation | A skill should add an agent workflow, not duplicate a README. |

Use the smallest delivery shape that provides a reliable execution contract.
Adding a plugin, MCP server, or CLI without a concrete need creates lifecycle
and security cost. Keeping deterministic work in prose creates reliability
cost.

## 2. Separate the three planes

A production skill distribution has three planes with different owners.

| Plane | Responsibility | Typical artifacts |
| --- | --- | --- |
| Capability plane | Tells an agent what the capability does, when to use it, and how to operate it | `SKILL.md`, references, examples |
| Execution plane | Performs deterministic work and returns inspectable results | Scripts, CLI, MCP server, API |
| Distribution plane | Resolves source, version, dependencies, installation scope, updates, and removal | Git release, package manager, plugin manifest, installer, managed-state record |

The planes MAY live in one repository, but their contracts MUST remain
distinct. In particular:

- `SKILL.md` MUST NOT be treated as an executable artifact merely because an
  agent can follow its commands.
- Distribution metadata MUST NOT be hidden only in prose that package tooling
  cannot inspect.
- Execution behavior MUST NOT depend on the model guessing undocumented flags,
  paths, schemas, or error recovery.

## 3. Define the portable skill contract

### 3.1 Core directory

The portable Agent Skills core is a directory containing `SKILL.md`, with
optional scripts, references, and assets:

```text
report-automation/
├── SKILL.md
├── scripts/
│   └── validate-report.sh
├── references/
│   ├── command-reference.md
│   └── troubleshooting.md
└── assets/
    └── report-template.md
```

Distribution systems MAY add files outside the portable core:

```text
report-automation/
├── SKILL.md
├── VERSION
├── agents/
│   └── openai.yaml
├── scripts/
├── references/
└── assets/
```

When adding non-standard files, the project MUST document which tool consumes
them. Portable clients are not required to understand `VERSION`, provider
metadata, plugin manifests, or a project-specific lockfile.

### 3.2 Frontmatter

Every `SKILL.md` MUST contain valid YAML frontmatter with:

- `name`: a stable, lowercase, hyphenated identifier that matches the parent
  directory;
- `description`: what the skill does and when the agent should use it.

Optional standard fields include `license`, `compatibility`, `metadata`, and
the experimental `allowed-tools` field. Because `allowed-tools` support varies
between clients, it MUST NOT be treated as a portable authorization boundary.

Example:

```markdown
---
name: report-automation
description: Use when creating, validating, or updating structured business reports from source data. Do not use for slide decks, spreadsheets, or general prose editing.
license: Apache-2.0
compatibility: Requires the reportctl CLI and local filesystem access.
metadata:
  author: example-org
  version: "1.0.0"
---
```

### 3.3 Description as routing table

The description is operational routing metadata, not a tagline. It MUST state:

1. the user outcomes the skill owns;
2. recognizable task language or artifact types;
3. important exclusions and adjacent skills it does not own;
4. environment constraints only when they affect activation.

A description SHOULD be tested against:

- positive prompts that must activate the skill;
- near-neighbor prompts that must not activate it;
- prompts that omit the product or file-format name but express the same user
  intent;
- ambiguous prompts where the agent should inspect or ask before choosing.

Renaming a skill or broadening its description can change routing for every
installed workspace. Treat such changes as compatibility changes, not copy
edits.

### 3.4 Progressive disclosure

Skills MUST be designed for three-stage loading:

1. **Catalog:** name and description are available at session start.
2. **Instructions:** the full `SKILL.md` body loads only after activation.
3. **Resources:** scripts, references, and assets load only when required.

Keep the main `SKILL.md` focused on the instructions needed in every matching
run. The Agent Skills specification recommends fewer than 5,000 tokens and 500
lines. Move detailed material into focused, directly referenced files.

A reference must have a loading condition. Prefer:

```markdown
Read `references/troubleshooting.md` when installation or verification returns
a non-zero exit status.
```

Avoid a generic instruction to read an entire reference directory.

## 4. Design the public entry point

### 4.1 Stable address

A product MAY publish a stable HTTPS address such as:

```text
https://example.com/SKILL.md
```

The address SHOULD be:

- short enough to share in a README, chat, issue, or product UI;
- served as plain, inspectable text without requiring sign-in;
- backed by a public source location or a documented provenance chain;
- stable across releases, with the resolved version shown before installation;
- available over TLS and protected by normal domain and release controls.

A stable mutable URL is acceptable as a discovery pointer. It SHOULD resolve
installation to an immutable release, tag, commit, content hash, or signed
artifact so that inspection and execution refer to the same content.

### 4.2 User-facing instruction

The safest one-line entry is an intent statement, not silent execution:

```text
Read https://example.com/SKILL.md. Show me the source, version, files, network
access, and permissions it requires. Ask before global changes, then install
and verify it.
```

If documentation shows `curl https://example.com/SKILL.md`, it MUST explain
that the command retrieves instructions; it does not make those instructions
trusted. The agent still needs to inspect provenance and authorize subsequent
actions.

### 4.3 Human fallback

Every agent-first installation path MUST provide a human-readable fallback
covering:

- supported platforms and prerequisites;
- manual download or package-manager installation;
- destination paths and configuration changes;
- verification;
- update, rollback, and uninstall.

An agent-first entry reduces onboarding work. It does not remove the need for
auditable human documentation.

## 5. Specify the installation contract

Installation is a state transition, not a list of shell commands. The installer
or installing agent MUST follow this sequence.

### 5.1 Preflight

Before changing state:

1. Detect operating system and architecture.
2. Detect the target agent clients and supported installation scopes.
3. Detect an existing installation, its source, version, and ownership mode.
4. Check required commands, runtimes, network access, credentials, and disk
   permissions.
5. Identify collisions with existing skills or binaries.
6. Stop with an actionable diagnostic when a hard prerequisite is missing.

Detection MUST be read-only.

### 5.2 Change plan and consent

Before a material mutation, show:

- the source and resolved version;
- files and directories that will be created, replaced, or removed;
- binaries, packages, services, hooks, or MCP registrations involved;
- network destinations;
- required privilege level;
- whether updates are automatic;
- the rollback and uninstall path.

The workflow MUST obtain explicit user consent before:

- elevated or administrator operations;
- global package installation;
- modifying shell profiles or system startup;
- registering a background service;
- storing credentials;
- enabling automatic updates;
- destructive replacement of an unmanaged installation.

Project-local writes already requested by the user MAY follow the host agent's
normal workspace permission model.

### 5.3 Artifact resolution and verification

The distribution plane SHOULD:

1. Resolve a version from an approved channel.
2. Download to a temporary location.
3. Verify a checksum or signature published through an independent release
   record.
4. Inspect or validate the package structure.
5. Move the verified payload into place atomically when the platform permits.

Do not rely on an unpinned branch for reproducible installation. Do not publish
a checksum beside an artifact if both can be silently replaced through the
same unprotected path.

### 5.4 Idempotency and ownership

Running installation twice with the same source, version, scope, and
configuration MUST reach the same state without duplicating files, hooks,
registrations, or services.

Managed installers MUST record enough state to distinguish:

- files they own and may reconcile;
- user-authored or forked files they must preserve;
- the installed source and version;
- registrations and services they created;
- retired payloads eligible for cleanup.

An installer MUST NOT overwrite a modified or unknown installation without
showing the conflict and obtaining an explicit replacement decision.

### 5.5 Post-install verification

Installation is incomplete until verification passes. Verification SHOULD
include:

- a version or identity check;
- skill discovery from the intended agent scope;
- one read-only help or capability query;
- a minimal smoke test of the execution plane;
- inspection of registrations, paths, or managed state;
- a clear final summary.

If verification fails, the workflow MUST report which state changed, what was
rolled back, what remains, and the safest recovery command or action.

## 6. Make the execution interface agent-native

A low-friction entry point cannot compensate for an interface that forces the
agent to guess.

### 6.1 Help and discovery

CLIs and tools SHOULD provide:

- `--help` at every command level;
- read-only help that never starts services or changes state;
- examples using accepted property names and value formats;
- machine-readable schema or capability discovery when the surface is large;
- an inspect command for current configuration and registrations.

The skill MUST tell the agent to consult help instead of inventing syntax.

### 6.2 Structured input and output

Deterministic interfaces SHOULD accept structured input and return structured
output. A CLI that supports `--json` SHOULD keep response shapes stable and
document them.

Errors SHOULD include:

- a stable error code;
- a human-readable explanation;
- the failing field, path, or operation;
- valid ranges or alternatives when known;
- a suggested next inspection step;
- a non-zero process exit status for failure.

Do not require agents to scrape decorative terminal output for correctness.

### 6.3 Safe operating ladder

For complex or destructive work, expose a progression such as:

```text
inspect -> plan or dry-run -> mutate -> validate -> render or review -> commit
```

The skill SHOULD direct the agent to the least powerful operation that can
complete the task. Escalation to lower-level APIs, raw formats, or destructive
flags should happen only when higher-level operations cannot satisfy the
request.

### 6.4 Validation loop

Every artifact-producing workflow SHOULD include a domain-appropriate feedback
loop:

```text
create or edit -> validate -> inspect result -> correct -> validate again
```

Validation may be structural, semantic, visual, or remote-state inspection.
The important property is that the agent can observe whether its work succeeded
without relying only on the absence of an exception.

## 7. Establish the security boundary

Remote skill distribution combines instruction loading, software supply chain,
tool execution, and model behavior. Treat it as a privileged extension path.

### 7.1 Threat model

At minimum, review these threats:

| Threat | Example | Required response |
| --- | --- | --- |
| Instruction injection | A cloned repository contains a skill that silently asks for unrelated actions | Require workspace trust and keep untrusted skills out of the catalog. |
| Mutable entry drift | A stable URL changes between inspection and installation | Resolve and display an immutable version or hash. |
| Compromised artifact | Installer or binary differs from the reviewed release | Verify signature or checksum and fail closed. |
| Name shadowing | A project skill overrides a trusted user skill | Use deterministic precedence and surface collisions. |
| Privilege escalation | Instructions request `sudo`, startup hooks, or global writes | Explain the consequence and obtain explicit consent. |
| Secret disclosure | A script prints tokens or sends them to an undeclared host | Use least-privilege credentials, redact output, and restrict destinations. |
| Persistent execution | Installation registers a daemon or hook | Declare it, expose status, and provide removal. |
| Unsafe auto-update | New instructions execute without review | Make update policy visible and support pinning and rollback. |

### 7.2 Trust rules

- A repository-local skill MUST NOT load automatically from an untrusted
  workspace.
- Downloading Markdown MUST NOT imply authorization to execute its commands.
- Tool allowlists in skill metadata MUST NOT replace host permissions or user
  consent.
- Installers MUST use least privilege and SHOULD prefer project or user scope
  over system scope.
- Secrets MUST NOT appear in examples, command histories, logs, or generated
  files.
- Network destinations SHOULD be enumerated before installation or first use.
- Verification failure involving provenance, signature, or checksum MUST fail
  closed.

### 7.3 `curl | shell` policy

Streaming a mutable network response directly into a shell collapses download,
inspection, verification, and execution into one step. Projects SHOULD prefer:

```text
download -> inspect provenance -> verify digest or signature -> execute
```

If a project still offers a streamed installer, it MUST:

- use HTTPS from a controlled domain;
- publish an equivalent manual installation path;
- document every persistent change;
- avoid requiring elevated privilege when possible;
- perform its own artifact verification;
- stop on download or verification failure;
- provide a version-pinned alternative;
- document uninstall and rollback.

## 8. Define scope, precedence, and composition

### 8.1 Installation scopes

Common scopes are:

| Scope | Intended use | Typical precedence |
| --- | --- | --- |
| Project | Repository-specific behavior and conventions | Highest |
| User | Capabilities available across a person's projects | Below project |
| Organization | Centrally distributed team capabilities | Runtime-defined |
| Built-in | Capabilities shipped with the agent client | Runtime-defined |

The Agent Skills format defines skill contents, not a universal filesystem
location or precedence algorithm. Every client or installer MUST document the
directories it scans and the precedence it applies. Collisions MUST produce a
diagnostic that identifies both sources and the selected winner.

### 8.2 Composition

Prefer independent skills with non-overlapping descriptions. When capabilities
must compose:

- identify one router or entry skill;
- name the specialized skills and their activation conditions;
- declare required execution dependencies;
- avoid loading multiple skills that issue conflicting instructions;
- define whether rules persist for one turn, one artifact, or one session;
- test the combined context cost and behavior.

Do not hide mandatory dependencies only in examples. If the distribution layer
does not support dependency resolution, the bundle installer MUST validate and
install the complete required set.

## 9. Own the full lifecycle

### 9.1 Source of truth

Each distributed skill MUST have one authoritative source. Generated mirrors
MUST identify their source version. Runtime-installed copies MUST NOT become
independent sources that users are expected to edit unless the installer
explicitly offers a forked mode.

### 9.2 Managed and forked modes

Projects MAY support both modes, but MUST distinguish them:

- **Managed mode:** read-only or reconciled installation, follows published
  updates, and preserves a known source relationship.
- **Forked mode:** copied into a project for local modification, no longer
  assumed to match upstream, and never overwritten automatically.

The product SHOULD make the choice explicit during installation.

### 9.3 Versioning and channels

The distribution plane SHOULD provide:

- immutable release versions;
- a visible source commit or artifact digest;
- stable, preview, or development channels when needed;
- compatibility requirements for agent clients and execution dependencies;
- migration notes for routing, permissions, and persisted state changes.

A change to a description, scope, default permission, installation path,
dependency, or cleanup behavior may be breaking even when the skill body still
performs the same domain task.

### 9.4 Update and rollback

Before update, show the current and target versions plus changes to permissions,
dependencies, files, registrations, and behavior. Updates MUST be idempotent and
MUST preserve user-owned files.

Rollback MUST restore a known compatible set: skill payload, execution
dependency, provider metadata, registrations, and managed-state record. Rolling
back only `SKILL.md` while leaving an incompatible binary is not a rollback.

### 9.5 Uninstall and retirement

Uninstall MUST remove every resource owned by that installation, including:

- skill payloads and provider mirrors;
- binaries or packages installed exclusively for the capability;
- MCP registrations, hooks, startup items, or background services;
- generated configuration that is safe to remove;
- managed-state entries.

It MUST preserve user data and modified files unless the user explicitly asks
for their removal.

Managed runtimes SHOULD reconcile desired state at session bootstrap or another
documented lifecycle point so retired skills do not accumulate. Retirement
SHOULD include a migration or replacement message when users still invoke the
old name.

## 10. Validate before release

Validation has four layers.

### 10.1 Static validation

Run deterministic checks for:

- Agent Skills frontmatter and directory naming;
- Markdown links and referenced file existence;
- scripts, schemas, plugin manifests, and provider metadata;
- accidental secrets and unsafe example values;
- version consistency across distribution artifacts;
- absence of placeholder instructions in release payloads.

Use the official `skills-ref` validator for the portable format when possible.
Project-specific validators should add stricter rules without claiming those
rules are part of the open format.

### 10.2 Routing evaluation

Maintain a small routing suite containing:

- required positive prompts;
- near-neighbor negative prompts;
- implicit-intent prompts;
- collision or multi-skill prompts;
- prompts that should ask for clarification.

Run deterministic metadata checks in normal CI. Run live-model routing tests
when a description, skill inventory, runtime catalog, or activation instruction
changes. Record the model and client used so results are comparable.

### 10.3 Installation matrix

Test from clean, isolated environments across supported operating systems,
architectures, agent clients, and installation scopes. Each matrix row should
cover:

1. fresh install;
2. repeat install;
3. upgrade;
4. failed verification;
5. rollback;
6. uninstall;
7. reinstall after uninstall.

Tests MUST use disposable credentials and isolated home/config directories.

### 10.4 Execution quality

Deterministic behavior belongs in product tests. Model-judgment tests are useful
for routing, instruction following, artifact quality, and cross-surface flows,
but they SHOULD remain a distinct, observable tier with explicit cost and
provider configuration.

### 10.5 Release gates

A release is not ready until all applicable statements are true:

- [ ] The correct delivery shape was chosen and documented.
- [ ] The `name` and `description` pass format and routing tests.
- [ ] A clean environment reaches the first useful result.
- [ ] A repeat install is idempotent.
- [ ] Material permissions and persistent changes are disclosed before use.
- [ ] Artifact provenance and integrity are verified.
- [ ] Help and error output support self-recovery.
- [ ] The primary workflow includes observable validation.
- [ ] Version pinning and update behavior are documented.
- [ ] Rollback restores a compatible set.
- [ ] Uninstall removes owned state and preserves user-owned data.
- [ ] Managed retirement removes deprecated payloads.
- [ ] Human documentation and agent instructions describe the same behavior.

## 11. Measure the distribution experience

Track measures that reveal friction and risk rather than only download counts:

- time from entry-point use to first verified result;
- clean-install success rate by platform and agent client;
- percentage of installs requiring manual recovery;
- routing precision and missed-activation rate;
- context cost at catalog and activated levels;
- verification failure categories;
- update and rollback success rates;
- uninstall completeness;
- frequency of name collisions and permission escalations;
- drift between installed payloads and their declared source.

Do not optimize activation volume at the expense of routing precision. A skill
that activates broadly but incorrectly increases context cost and can change
agent behavior outside its authority.

## 12. Apply the playbook to a new project

Use this sequence for every new capability.

### Step 1: Write a capability brief

Record:

- target users and agents;
- user problem and desired outcome;
- representative prompts and artifacts;
- deterministic operations required;
- external systems, credentials, and persistent state;
- non-goals and neighboring capabilities.

### Step 2: Select the delivery shape

Choose skill-only, skill plus execution plane, or bundle. Record why the next
simpler shape is insufficient.

### Step 3: Define routing before instructions

Draft the name, description, positive prompts, and negative prompts. Resolve
overlap with existing skills before writing the body.

### Step 4: Design installation and trust

Define source, scope, version, preflight, permissions, artifact verification,
managed ownership, update, rollback, and uninstall.

### Step 5: Design the execution contract

Specify commands or tools, structured input/output, help, stable errors,
inspection, dry-run, and validation.

### Step 6: Author with progressive disclosure

Keep the core procedure in `SKILL.md`. Move detailed references, schemas,
templates, and reusable deterministic code into their appropriate directories.

### Step 7: Build the test layers

Add static validation, routing cases, clean-install lifecycle coverage, product
tests, and any opt-in model-quality evaluation.

### Step 8: Publish and observe

Publish an immutable release, point the stable entry at it, record provenance,
monitor failures, and feed repeated recovery knowledge back into help,
diagnostics, tests, or the skill.

## 13. Common anti-patterns

### `SKILL.md` as a giant manual

**Failure:** Every activation loads reference material irrelevant to the current
task.

**Correction:** Keep the main procedure focused and load references by explicit
condition.

### Description as marketing copy

**Failure:** The agent cannot determine when to activate the skill.

**Correction:** Name owned outcomes, task language, artifacts, and exclusions.

### Markdown as a security exception

**Failure:** Remote instructions are treated as harmless even though they can
cause tool execution.

**Correction:** Apply provenance, trust, permission, and least-privilege rules
before following commands.

### Install-only lifecycle

**Failure:** The project has no ownership record, upgrade safety, rollback, or
uninstall.

**Correction:** Design every lifecycle transition before publishing the first
installer.

### Prose for deterministic work

**Failure:** The model repeatedly reimplements parsing, mutation, or validation
with inconsistent results.

**Correction:** Move repeatable mechanics into scripts, a CLI, MCP, or API.

### Hidden dependencies

**Failure:** A skill works only when another skill or tool happens to be
installed.

**Correction:** Declare and validate the complete dependency set in the
distribution plane.

### Silent scope collision

**Failure:** A project skill shadows a trusted user skill without explanation.

**Correction:** Apply deterministic precedence and show both sources.

### Mutable auto-update without rollback

**Failure:** New instructions or binaries reach users without a recoverable
version boundary.

**Correction:** Publish immutable versions, expose update policy, and preserve a
compatible rollback set.

## 14. Copyable authoring template

Use this template after the delivery shape, installation contract, and
execution interface are defined.

```markdown
---
name: capability-name
description: Use when the user needs [owned outcomes] involving [recognizable artifacts or task language]. Do not use for [neighboring tasks owned elsewhere].
license: Apache-2.0
compatibility: Requires [runtime, command, network, or platform constraint].
metadata:
  author: organization-name
  version: "1.0.0"
---

# Capability Name

State the concrete outcome this skill owns in one paragraph.

## Preconditions

1. Inspect whether the required execution dependency is installed.
2. Inspect the current version and configuration without changing state.
3. If a prerequisite is missing, follow the installation section before work.

## Installation

1. Show the source, resolved version, destination paths, network access, and
   permissions.
2. Obtain consent for global, elevated, persistent, or credential changes.
3. Install the verified, pinned artifact through the documented distribution
   path.
4. Run the version check and read-only smoke test.
5. Stop and report residual state if verification fails.

## Operating procedure

1. Inspect the target and current state.
2. Select the least powerful operation that can produce the requested result.
3. Use structured input and request structured output when available.
4. Perform the operation.
5. Run domain validation and inspect the produced result.
6. Correct validation failures and validate again.

## Help and recovery

- Read `references/command-reference.md` before inventing command syntax.
- Read `references/troubleshooting.md` after a non-zero exit status or failed
  verification.
- Preserve the original artifact until validation succeeds.

## Update and removal

- Show the current and target versions before update.
- Preserve user-owned data and modified files.
- Verify the complete compatible set after update or rollback.
- Use the documented uninstaller to remove owned payloads, registrations,
  hooks, services, and managed-state entries.
```

Replace bracketed authoring fields before release. A release validator SHOULD
fail if bracketed fields remain in a distributed payload.

## 15. Source notes

This playbook combines facts from the open Agent Skills format with engineering
patterns observed in production-oriented skill repositories. The distinction
matters:

- The Agent Skills specification defines the portable skill directory,
  frontmatter, and progressive-disclosure model.
- Client implementation guidance describes common discovery scopes, precedence,
  activation, and workspace trust considerations.
- OfficeCLI demonstrates a stable skill URL as an agent-facing product entry,
  backed by a deterministic CLI, help, structured output, validation, and
  specialized routing.
- `mattpocock/skills` demonstrates the product distinction between an editable
  copied skill set and a managed plugin subscription.
- Google Stitch Skills demonstrates open-format skills packaged into related
  plugin bundles.

The control-plane, distribution-plane, security, lifecycle, and release-gate
rules in this document are engineering guidance derived from those sources;
they are not all requirements of the Agent Skills open specification.

Pinned references reviewed for this revision:

- [Agent Skills specification](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/specification.mdx)
- [Agent Skills client implementation guide](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/client-implementation/adding-skills-support.mdx)
- [Optimizing skill descriptions](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/skill-creation/optimizing-descriptions.mdx)
- [Agent Skills authoring best practices](https://github.com/agentskills/agentskills/blob/38a2ff82958afee88dadf4831509e6f7e9d8ef4e/docs/skill-creation/best-practices.mdx)
- [OfficeCLI README](https://github.com/iOfficeAI/OfficeCLI/blob/4ba79f0b984e141f57f58d4398ba2df29e8187e8/README.md)
- [OfficeCLI `SKILL.md`](https://github.com/iOfficeAI/OfficeCLI/blob/4ba79f0b984e141f57f58d4398ba2df29e8187e8/SKILL.md)
- [`mattpocock/skills` README](https://github.com/mattpocock/skills/blob/c70cb091933617c61acf9bd6c3b01c1140329cf1/README.md)
- [`mattpocock/skills` plugin ADR](https://github.com/mattpocock/skills/blob/c70cb091933617c61acf9bd6c3b01c1140329cf1/.agents/adr/0002-ship-as-a-claude-code-plugin.md)
- [Google Stitch Skills README](https://github.com/google-labs-code/stitch-skills/blob/ad4b8bc8c51991f53214b573c98eb4f46807e178/README.md)
- [Google Stitch Design plugin manifest](https://github.com/google-labs-code/stitch-skills/blob/ad4b8bc8c51991f53214b573c98eb4f46807e178/plugins/stitch-design/plugin.json)
