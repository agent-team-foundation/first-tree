#!/usr/bin/env bash
set -euo pipefail

topic="${1:-overview}"

print_topics() {
  cat <<'EOF'
Supported topics:
  overview
  cli
  init
  verify
  upgrade
  principles
  ownership
  members
  workflows
  templates
  tests
EOF
}

print_block() {
  cat <<EOF
$1
EOF
}

case "$topic" in
  --list|-l|list)
    print_topics
    ;;
  overview)
    print_block "Topic: overview

Read in order:
- references/portable-quickstart.md — how to use this skill after copying it elsewhere
- references/repo-snapshot/AGENTS.md — repo boundary and working rules
- references/repo-snapshot/README.md — user-facing command surface and framework shape
- references/repo-snapshot/docs/about.md — product intent and problem statement
- references/repo-snapshot/docs/onboarding.md — onboarding flow emitted by the CLI
- references/repo-snapshot/src/cli.ts — command dispatch
- references/repo-snapshot/src/init.ts — framework copy + task generation

Use after reading:
- ./scripts/run-local-cli.sh --help
- ./scripts/run-local-cli.sh help onboarding"
    ;;
  cli)
    print_block "Topic: cli

Read in order:
- references/repo-snapshot/src/cli.ts — command names, usage text, dispatch
- references/repo-snapshot/src/onboarding.ts — onboarding bridge
- references/repo-snapshot/src/repo.ts — repo inspection helpers used by commands
- references/context-tree-source-map.md — companion map for nearby files

Use after reading:
- ./scripts/run-local-cli.sh --help
- ./scripts/run-local-cli.sh --version"
    ;;
  init)
    print_block "Topic: init

Read in order:
- references/repo-snapshot/src/init.ts — clone/copy/template/progress flow
- references/repo-snapshot/src/rules/index.ts — rule ordering
- references/repo-snapshot/src/rules/*.ts — task generation content
- references/repo-snapshot/.context-tree/templates/*.template — rendered scaffolds
- references/repo-snapshot/tests/init.test.ts and references/repo-snapshot/tests/rules.test.ts — expected behavior

Use after reading:
- ./scripts/run-local-cli.sh init"
    ;;
  verify)
    print_block "Topic: verify

Read in order:
- references/repo-snapshot/src/verify.ts — progress gating and top-level checks
- references/repo-snapshot/src/validators/nodes.ts — structural validation
- references/repo-snapshot/src/validators/members.ts — member validation
- references/repo-snapshot/tests/verify.test.ts
- references/repo-snapshot/tests/validate-nodes.test.ts
- references/repo-snapshot/tests/validate-members.test.ts

Use after reading:
- ./scripts/run-local-cli.sh verify"
    ;;
  upgrade)
    print_block "Topic: upgrade

Read in order:
- references/repo-snapshot/src/upgrade.ts — upstream comparison and upgrade tasks
- references/repo-snapshot/src/repo.ts — upstream remote detection
- references/repo-snapshot/.context-tree/VERSION — local framework version marker
- references/repo-snapshot/.context-tree/templates/agent.md.template — framework block expectations
- references/repo-snapshot/tests/init.test.ts and references/repo-snapshot/tests/verify.test.ts for adjacent behavior

Use after reading:
- ./scripts/run-local-cli.sh upgrade"
    ;;
  principles)
    print_block "Topic: principles

Read in order:
- references/context-tree-maintenance-principles.md
- references/repo-snapshot/.context-tree/principles.md
- references/repo-snapshot/docs/about.md
- references/repo-snapshot/docs/onboarding.md
- references/repo-snapshot/.context-tree/templates/agent.md.template

Goal:
- recover the full decision-vs-execution model before changing framework guidance"
    ;;
  ownership)
    print_block "Topic: ownership

Read in order:
- references/context-tree-maintenance-principles.md
- references/repo-snapshot/.context-tree/ownership-and-naming.md
- references/repo-snapshot/src/validators/nodes.ts
- references/repo-snapshot/.context-tree/generate-codeowners.ts
- references/repo-snapshot/tests/validate-nodes.test.ts
- references/repo-snapshot/tests/generate-codeowners.test.ts"
    ;;
  members)
    print_block "Topic: members

Read in order:
- references/context-tree-maintenance-principles.md
- references/repo-snapshot/.context-tree/templates/members-domain.md.template
- references/repo-snapshot/.context-tree/templates/member-node.md.template
- references/repo-snapshot/src/validators/members.ts
- references/repo-snapshot/tests/validate-members.test.ts"
    ;;
  workflows)
    print_block "Topic: workflows

Read in order:
- references/repo-snapshot/src/rules/ci-validation.ts
- references/repo-snapshot/.context-tree/workflows/validate.yml
- references/repo-snapshot/.context-tree/workflows/pr-review.yml
- references/repo-snapshot/.context-tree/workflows/codeowners.yml
- references/repo-snapshot/.context-tree/run-review.ts
- references/repo-snapshot/.context-tree/generate-codeowners.ts
- references/repo-snapshot/.context-tree/examples/claude-code/README.md"
    ;;
  templates)
    print_block "Topic: templates

Read in order:
- references/repo-snapshot/.context-tree/templates/root-node.md.template
- references/repo-snapshot/.context-tree/templates/agent.md.template
- references/repo-snapshot/.context-tree/templates/members-domain.md.template
- references/repo-snapshot/.context-tree/templates/member-node.md.template
- references/repo-snapshot/src/init.ts — how templates are rendered
- references/repo-snapshot/tests/init.test.ts"
    ;;
  tests)
    print_block "Topic: tests

Read in order:
- references/context-tree-source-map.md
- references/repo-snapshot/tests/init.test.ts
- references/repo-snapshot/tests/rules.test.ts
- references/repo-snapshot/tests/verify.test.ts
- references/repo-snapshot/tests/validate-nodes.test.ts
- references/repo-snapshot/tests/validate-members.test.ts
- references/repo-snapshot/tests/generate-codeowners.test.ts
- references/repo-snapshot/tests/repo.test.ts
- references/repo-snapshot/tests/run-review.test.ts
- references/repo-snapshot/evals/tests/eval-helpers.test.ts"
    ;;
  *)
    echo "Unknown topic: $topic" >&2
    echo >&2
    print_topics >&2
    exit 1
    ;;
esac
