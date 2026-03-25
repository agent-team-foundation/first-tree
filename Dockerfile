FROM node:24-alpine AS deps
RUN apk add --no-cache python3 make g++
RUN corepack enable
WORKDIR /app

# Copy package manifests for dependency layer caching
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
COPY packages/command/package.json packages/command/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile

# --- Build stage ---
FROM deps AS build
COPY . .
RUN pnpm build

# --- Production dependencies (no devDependencies, native modules pre-compiled) ---
FROM deps AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# --- Runtime ---
FROM node:24-alpine
WORKDIR /app

# Production node_modules (includes compiled bcrypt, workspace links)
COPY --from=prod-deps /app ./

# Build artifacts
COPY --from=build /app/packages/shared/dist packages/shared/dist/
COPY --from=build /app/packages/server/dist packages/server/dist/
COPY --from=build /app/packages/client/dist packages/client/dist/
COPY --from=build /app/packages/command/dist packages/command/dist/

# Runtime data: database migrations + web static files
COPY --from=build /app/packages/server/drizzle packages/server/drizzle/
COPY --from=build /app/packages/web/dist packages/web/dist/

ENV NODE_ENV=production
EXPOSE 8000

CMD ["node", "packages/command/dist/cli/index.mjs", "server", "start", "--no-interactive"]
