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
COPY packages/web ./packages/web
COPY packages/shared ./packages/shared
COPY packages/sdk ./packages/sdk
WORKDIR /app/packages/web
ARG VEQSIO_BUILD=dev
ENV VEQSIO_BUILD=$VEQSIO_BUILD
RUN bun run build

# Production stage — Next.js standalone output (monorepo-aware)
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
# Next.js standalone preserves workspace structure
COPY --from=builder /app/packages/web/.next/standalone /app
# Static assets are not included in standalone output by default
COPY --from=builder /app/packages/web/.next/static /app/packages/web/.next/static
# Icons, service worker and the offline page
COPY --from=builder /app/packages/web/public /app/packages/web/public
# Licence texts travel with the image: the AGPL, the notices of the third-party packages (MIT/Apache/BSD require them in binary distributions) and, when present, the Enterprise licence in /app/ee.
COPY LICENSE NOTICE THIRD-PARTY-NOTICES.md /licenses/
COPY licenses/ /licenses/
WORKDIR /app/packages/web
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/ || exit 1
CMD ["node", "server.js"]
