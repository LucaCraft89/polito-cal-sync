# syntax=docker/dockerfile:1

# ---- build: compile TypeScript and produce production-only node_modules ----
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# better-sqlite3 ships a prebuilt linux binary, so no compiler toolchain is needed
# (its implicit node-gyp build is disabled in package.json: pnpm.ignoredBuiltDependencies).
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build \
 && pnpm prune --prod

# ---- runtime: no compilers, no pnpm, non-root ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    STATUS_BIND=0.0.0.0 \
    TZ=Europe/Rome
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# /data is the only writable place: state, tokens and the sqlite db live here (mode 0600 files)
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD ["node", "dist/main.js", "healthcheck"]
ENTRYPOINT ["node", "dist/main.js"]
CMD ["serve"]
