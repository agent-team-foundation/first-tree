FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /app

# Copy package manifests for dependency layer caching. Only the packages
# needed to build + run the SaaS server image: shared, server, web.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile \
    --filter @first-tree/shared... \
    --filter @first-tree/server... \
    --filter @first-tree/web...

# --- Build stage ---
FROM deps AS build
COPY . .
ARG FIRST_TREE_GIT_SHA=unknown
ENV FIRST_TREE_WEB_BUILD_ID=$FIRST_TREE_GIT_SHA
ENV FIRST_TREE_GIT_SHA=$FIRST_TREE_GIT_SHA
ARG SENTRY_ORG
ARG SENTRY_PROJECT_WEB=first-tree-web
ENV SENTRY_ORG=$SENTRY_ORG
ENV SENTRY_PROJECT_WEB=$SENTRY_PROJECT_WEB
ARG VITE_SENTRY_DSN
ARG VITE_SENTRY_ENVIRONMENT=production
ARG VITE_SENTRY_TRACES_SAMPLE_RATE=0.1
ENV VITE_SENTRY_DSN=$VITE_SENTRY_DSN
ENV VITE_SENTRY_ENVIRONMENT=$VITE_SENTRY_ENVIRONMENT
ENV VITE_SENTRY_TRACES_SAMPLE_RATE=$VITE_SENTRY_TRACES_SAMPLE_RATE
RUN pnpm --filter @first-tree/shared build
RUN pnpm --filter @first-tree/server build
RUN --mount=type=secret,id=SENTRY_AUTH_TOKEN,required=false \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/SENTRY_AUTH_TOKEN 2>/dev/null || true)" \
    SENTRY_RELEASE="first-tree-web@${FIRST_TREE_GIT_SHA}" \
    pnpm --filter @first-tree/web build

# --- Production dependencies (no devDependencies) ---
FROM deps AS prod-deps
RUN pnpm install --frozen-lockfile --prod \
    --filter @first-tree/shared... \
    --filter @first-tree/server...

# --- Runtime ---
FROM node:24-alpine
WORKDIR /app

# Bootstrap Command-package version baked into the image. CI passes this as
# `--build-arg COMMAND_VERSION=$(node -p "require('./apps/cli/package.json').version")`,
# so a freshly-built image always advertises the in-tree CLI version BEFORE
# the npm-registry poller takes over at runtime. Default `0.0.0` keeps local
# `docker build` (without the build-arg) from crashing — it's SemVer-valid so
# the welcome frame stays well-formed, and the poller overwrites it within a
# poll interval anyway.
ARG COMMAND_VERSION=0.0.0
ENV FIRST_TREE_COMMAND_VERSION=$COMMAND_VERSION

# Production node_modules (includes compiled bcrypt, workspace links)
COPY --from=prod-deps /app ./

# Build artifacts: shared (workspace dep) + server entry
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/server/dist packages/server/dist/

# Runtime data: drizzle migrations (server bootstrap runs them) + web SPA
COPY --from=build /app/packages/server/drizzle packages/server/drizzle/
COPY --from=build /app/packages/web/dist packages/server/web-dist/

# git is required by the server-managed Context Tree mirror used by
# /api/v1/context-tree/snapshot. wget is used by the container healthcheck.
RUN apk add --no-cache git wget

RUN addgroup -S firsttree && \
    adduser -S -G firsttree firsttree
    
ENV NODE_ENV=production
ENV FIRST_TREE_WEB_DIST_PATH=/app/packages/server/web-dist
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://localhost:8000/healthz || exit 1

USER firsttree

CMD ["node", "packages/server/dist/index.mjs"]
