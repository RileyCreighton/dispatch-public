FROM node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd AS build
RUN apt-get update && apt-get install -y --no-install-recommends perl-base=5.36.0-7+deb12u4 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY db ./db
COPY tests/foundation/unit.test.mjs ./tests/foundation/unit.test.mjs
COPY docs/architecture/openapi.yaml ./docs/architecture/openapi.yaml
RUN test "$(npm --version)" = "11.19.0" \
    && npm ci --ignore-scripts --no-audit --no-fund && npm run build && npm test && npm prune --omit=dev --ignore-scripts
FROM node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd
# No package installer is required by this immutable compiled-Node runtime.
# Remove apt with its GnuTLS dependency; retain Node's independent OpenSSL TLS.
RUN apt-get update && apt-get install -y --no-install-recommends perl-base=5.36.0-7+deb12u4 \
    && apt-get purge -y --allow-remove-essential apt libapt-pkg6.0 libgnutls30 \
    && rm -rf /var/lib/apt/lists/* \
    && test ! -e /usr/lib/x86_64-linux-gnu/libgnutls.so.30 \
    && test ! -e /usr/bin/apt-get \
    && ! ldd /usr/local/bin/node | grep -q 'not found'
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/package.json ./package.json
# Runtime entrypoints execute compiled JavaScript with node. Build-only native
# TypeScript optional peers can survive npm prune; do not ship those executables
# or the base image's package managers in the application runtime.
RUN rm -rf /app/node_modules/typescript /app/node_modules/@typescript \
    /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && node -e "for (const p of ['/app/node_modules/typescript','/app/node_modules/@typescript','/usr/local/bin/npm']) if (require('fs').existsSync(p)) process.exit(1)"
USER node
CMD ["node","dist/apps/api/src/main.js"]
