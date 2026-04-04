# Dockerfile for running context-tree evals with claude --dangerously-skip-permissions
#
# Build:
#   docker build -t ct-eval -f evals/Dockerfile .
#
# Run (single case):
#   docker run --rm \
#     -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
#     -e GH_TOKEN="$(gh auth token)" \
#     -e EVALS=1 \
#     -e EVALS_CASES=pydantic-importstring-error \
#     -e EVALS_TREE_REPO=agent-team-foundation/eval-context-trees \
#     -v ~/.context-tree/evals:/home/eval/.context-tree/evals \
#     ct-eval
#
# Run (all cases):
#   docker run --rm \
#     -e ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
#     -e GH_TOKEN="$(gh auth token)" \
#     -e EVALS=1 \
#     -e EVALS_TREE_REPO=agent-team-foundation/eval-context-trees \
#     -v ~/.context-tree/evals:/home/eval/.context-tree/evals \
#     ct-eval
#
# The -v mount persists eval results (JSON + HTML) to your host.

FROM node:22-bookworm

# System dependencies for cloning repos and running Python evals
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Rust (needed for pydantic-core compilation)
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y \
    && ln -s /root/.cargo/bin/* /usr/local/bin/

# Install uv and Python 3.12 (eval cases require 3.12+).
# We install Python via uv, then symlink into /usr/local/bin so both
# the system `python3` and `uv venv` find Python 3.12.
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && cp /root/.local/bin/uv /usr/local/bin/uv \
    && cp /root/.local/bin/uvx /usr/local/bin/uvx \
    && uv python install 3.12 \
    && ln -sf $(uv python find 3.12) /usr/local/bin/python3.12 \
    && ln -sf /usr/local/bin/python3.12 /usr/bin/python3

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install GitHub CLI (needed for cloning private repos / tree repos)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Install deps as root first (corepack needs root), then switch to non-root
WORKDIR /app
COPY . .
RUN CI=true pnpm install --frozen-lockfile

# Create non-root user (required: claude blocks --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash eval \
    && cp -a /app /home/eval/first-tree \
    && chown -R eval:eval /home/eval
USER eval
WORKDIR /home/eval/first-tree

# Create eval results directory and set git safe.directory globally
RUN mkdir -p /home/eval/.context-tree/evals \
    && git config --global --add safe.directory '*'

# Ensure uv/pnpm caches are writable inside the container
ENV UV_CACHE_DIR=/tmp/uv-cache

# Default: run evals
ENTRYPOINT ["pnpm", "run", "eval"]
