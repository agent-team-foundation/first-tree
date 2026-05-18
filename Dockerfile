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
    --filter @agent-team-foundation/first-tree-hub-shared... \
    --filter @first-tree-hub/server... \
    --filter @first-tree-hub/web...

# --- Build stage ---
FROM deps AS build
COPY . .
RUN pnpm --filter @agent-team-foundation/first-tree-hub-shared build
RUN pnpm --filter @first-tree-hub/server build
RUN pnpm --filter @first-tree-hub/web build

# --- Production dependencies (no devDependencies) ---
FROM deps AS prod-deps
RUN pnpm install --frozen-lockfile --prod \
    --filter @agent-team-foundation/first-tree-hub-shared... \
    --filter @first-tree-hub/server...

# --- Runtime ---
FROM node:24-alpine
WORKDIR /app

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

ENV NODE_ENV=production
ENV FIRST_TREE_HUB_WEB_DIST_PATH=/app/packages/server/web-dist
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- http://localhost:8000/healthz || exit 1

CMD ["node", "packages/server/dist/index.mjs"]
