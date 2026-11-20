# Build from repository root so workspace dependencies resolve
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/api/package.json ./packages/api/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/client/package.json ./packages/client/
COPY packages/mcp/package.json ./packages/mcp/
COPY packages/web/package.json ./packages/web/
# Bundled modules (workspaces): community modules/ and Enterprise ee/modules/
COPY modules ./modules
COPY ee ./ee
RUN bun install --frozen-lockfile
COPY packages/api/src ./packages/api/src
COPY packages/api/tsconfig.json ./packages/api/
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY packages/sdk ./packages/sdk
WORKDIR /app/packages/api
RUN bun build src/index.ts --outdir dist --target bun

# Production stage — minimal image with only the bundled artifact
FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production
# Build identifier shown in the footer and on /rest/api/2/serverInfo (pass --build-arg VEQSIO_BUILD=$(git rev-parse --short HEAD))
ARG VEQSIO_BUILD=dev
ENV VEQSIO_BUILD=$VEQSIO_BUILD
COPY --from=builder /app/packages/api/dist/index.js ./dist/index.js
# Bundled modules are discovered on disk at start (community modules/ and paid ee/modules/): ship their sources and the
# workspace packages and dependencies they import, and tell the host where to look (the bundle does not know the repo layout).
COPY --from=builder /app/node_modules ./node_modules
# every workspace package with its own node_modules (the modules import API internals by relative path: ../../../../../packages/api/src/...)
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/modules ./modules
COPY --from=builder /app/ee ./ee
# Licence texts travel with the image: the AGPL, the notices of the third-party packages (MIT/Apache/BSD require them in binary distributions) and, when present, the Enterprise licence in /app/ee.
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md /licenses/
COPY licenses/ /licenses/
ENV VEQSIO_MODULE_DIRS=/app/modules,/app/ee/modules
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"
CMD ["bun", "dist/index.js"]
