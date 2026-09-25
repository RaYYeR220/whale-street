# Whale Street engine: REST, WebSocket and MCP on one port.
# Build from the repository root: docker build -t whale-street-engine .
# Without a Nansen key the engine runs REPLAY; its SQLite file lives under DATA_DIR and is
# recreated from the replay session at every start.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN npm install -g pnpm@10.34.5
# Manifests first, so the dependency layer is reused until one of them changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/hl/package.json packages/hl/
COPY packages/nansen/package.json packages/nansen/
COPY apps/engine/package.json apps/engine/
COPY apps/web/package.json apps/web/
# Production dependencies of the engine and the workspace packages it uses (tsx runs the
# TypeScript sources and is one of them): no web app, no dev tools.
RUN pnpm install --frozen-lockfile --prod --filter "@whale-street/engine..."
COPY packages ./packages
COPY apps/engine ./apps/engine
# better-sqlite3 ships prebuilt binaries; fail the build here if the native module does not load.
RUN cd apps/engine && node -e "const D = require('better-sqlite3'); new D(':memory:').prepare('select 1').get(); console.log('sqlite ok')"

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    DATA_DIR=/tmp/whale-street
WORKDIR /app
COPY --from=build /app /app
USER node
WORKDIR /app/apps/engine
EXPOSE 10000
CMD ["node", "--import", "tsx", "src/main.ts"]
