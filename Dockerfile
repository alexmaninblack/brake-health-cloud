# SPDX-FileCopyrightText: 2026 maninblack
# SPDX-License-Identifier: Apache-2.0
FROM node:26.0.0-bookworm-slim@sha256:34881fd97f67bed28bbfe3614a219e7d793e2b7554de33eaf71797d9dc8a35cc AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY apps/backend/package.json apps/backend/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/test-support/package.json packages/test-support/package.json
RUN npm install --global npm@11.12.1 --ignore-scripts --no-audit --no-fund && npm ci --ignore-scripts --no-audit --no-fund
COPY apps/backend apps/backend
RUN node node_modules/typescript/bin/tsc -p apps/backend/tsconfig.build.json --pretty false

FROM node:26.0.0-bookworm-slim@sha256:34881fd97f67bed28bbfe3614a219e7d793e2b7554de33eaf71797d9dc8a35cc
WORKDIR /app
COPY --from=build /app/out/backend ./out/backend
COPY package.json ./package.json
COPY migrations ./migrations
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /data /tmp/demo-backend && chown node:node /data /tmp/demo-backend
USER node
EXPOSE 18091
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 CMD ["node", "--input-type=module", "-e", "const r = await fetch('http://127.0.0.1:18091/health/ready', {signal: AbortSignal.timeout(2000)}); const b = await r.json(); process.exit(r.status === 200 && b.ready === true ? 0 : 1)"]
ENTRYPOINT ["node", "/app/out/backend/main.js"]
CMD ["--runtime-mode", "container", "--port", "18091", "--database-path", "/data/brake-health.sqlite", "--admin-socket-path", "/tmp/demo-backend/admin.sock", "--context-path", "/run/demo-control/context/current-unit-context.json", "--migrations-directory", "/app/migrations"]
