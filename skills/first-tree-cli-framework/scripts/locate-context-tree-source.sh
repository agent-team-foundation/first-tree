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
- AGENTS.md — repo boundary and working rules
- README.md — user-facing command surface and framework shape
- docs/about.md — product intent and problem statement
- docs/onboarding.md — onboarding flow emitted by the CLI
- src/cli.ts — command dispatch
- src/init.ts — framework copy + task generation

Use after reading:
- ./scripts/run-local-cli.sh --help
- ./scripts/run-local-cli.sh help onboarding"
    ;;
  cli)
    print_block "Topic: cli

Read in order:
- src/cli.ts — command names, usage text, dispatch
- src/onboarding.ts — onboarding bridge
- src/repo.ts — repo inspection helpers used by commands
- references/context-tree-source-map.md — companion map for nearby files

Use after reading:
- ./scripts/run-local-cli.sh --help
- ./scripts/run-local-cli.sh --version"
    ;;
  init)
    print_block "Topic: init

Read in order:
- src/init.ts — clone/copy/template/progress flow
- src/rules/index.ts — rule ordering
- src/rules/*.ts — task generation content
- .context-tree/templates/*.template — rendered scaffolds
- tests/init.test.ts and tests/rules.test.ts — expected behavior

Use after reading:
- ./scripts/run-local-cli.sh init"
    ;;
  verify)
    print_block "Topic: verify

Read in order:
- src/verify.ts — progress gating and top-level checks
- src/validators/nodes.ts — structural validation
- src/validators/members.ts — member validation
- tests/verify.test.ts
- tests/validate-nodes.test.ts
- tests/validate-members.test.ts

Use after reading:
- ./scripts/run-local-cli.sh verify"
    ;;
  upgrade)
    print_block "Topic: upgrade

Read in order:
- src/upgrade.ts — upstream comparison and upgrade tasks
- src/repo.ts — upstream remote detection
- .context-tree/VERSION — local framework version marker
- .context-tree/templates/agent.md.template — framework block expectations
- tests/init.test.ts and tests/verify.test.ts for adjacent behavior

Use after reading:
- ./scripts/run-local-cli.sh upgrade"
    ;;
  principles)
    print_block "Topic: principles

Read in order:
- references/context-tree-maintenance-principles.md
- .context-tree/principles.md
- docs/about.md
- docs/onboarding.md
- .context-tree/templates/agent.md.template

Goal:
- recover the full decision-vs-execution model before changing framework guidance"
    ;;
  ownership)
    print_block "Topic: ownership

Read in order:
- references/context-tree-maintenance-principles.md
- .context-tree/ownership-and-naming.md
- src/validators/nodes.ts
- .context-tree/generate-codeowners.ts
- tests/validate-nodes.test.ts
- tests/generate-codeowners.test.ts"
    ;;
  members)
    print_block "Topic: members

Read in order:
- references/context-tree-maintenance-principles.md
- .context-tree/templates/members-domain.md.template
- .context-tree/templates/member-node.md.template
- src/validators/members.ts
- tests/validate-members.test.ts"
    ;;
  workflows)
    print_block "Topic: workflows

Read in order:
- src/rules/ci-validation.ts
- .context-tree/workflows/validate.yml
- .context-tree/workflows/pr-review.yml
- .context-tree/workflows/codeowners.yml
- .context-tree/run-review.ts
- .context-tree/generate-codeowners.ts
- .context-tree/examples/claude-code/README.md"
    ;;
  templates)
    print_block "Topic: templates

Read in order:
- .context-tree/templates/root-node.md.template
- .context-tree/templates/agent.md.template
- .context-tree/templates/members-domain.md.template
- .context-tree/templates/member-node.md.template
- src/init.ts — how templates are rendered
- tests/init.test.ts"
    ;;
  tests)
    print_block "Topic: tests

Read in order:
- references/context-tree-source-map.md
- tests/init.test.ts
- tests/rules.test.ts
- tests/verify.test.ts
- tests/validate-nodes.test.ts
- tests/validate-members.test.ts
- tests/generate-codeowners.test.ts
- tests/repo.test.ts
- tests/run-review.test.ts
- evals/tests/eval-helpers.test.ts"
    ;;
  *)
    echo "Unknown topic: $topic" >&2
    echo >&2
    print_topics >&2
    exit 1
    ;;
esac
