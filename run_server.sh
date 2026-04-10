export FIRST_TREE_HUB_HOME=~/.first-tree-hub-test
export FIRST_TREE_HUB_DATABASE_URL=postgresql://firsttreehub:firsttreehub@localhost:5432/first_tree_hub
export FIRST_TREE_HUB_CONTEXT_TREE_REPO=https://github.com/baixiaohang/test-context-tree
export FIRST_TREE_HUB_GITHUB_TOKEN=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
export FIRST_TREE_HUB_GITHUB_ALLOWED_ORG=agent-team-foundation

export DATABASE_URL=$FIRST_TREE_HUB_DATABASE_URL

pnpm --filter @first-tree-hub/server db:migrate

npx tsx packages/command/src/cli/index.ts server start --no-interactive
