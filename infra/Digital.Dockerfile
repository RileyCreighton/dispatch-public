FROM node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd AS build
RUN apt-get update && apt-get install -y --no-install-recommends perl-base=5.36.0-7+deb12u4 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY examples ./examples
COPY db ./db
COPY tests/foundation/unit.test.mjs ./tests/foundation/unit.test.mjs
COPY docs/architecture/openapi.yaml ./docs/architecture/openapi.yaml
RUN test "$(npm --version)" = "11.19.0" && npm ci --ignore-scripts --no-audit --no-fund \
    && npm run build && npm run check:web && npm run build:web && npm test
FROM build AS fixture-build
COPY tests/payment/tooling/package*.json ./tests/payment/tooling/
RUN npm ci --prefix tests/payment/tooling --ignore-scripts --no-audit --no-fund
FROM build AS dependencies
RUN npm prune --omit=dev --ignore-scripts
FROM node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd AS runtime
# This immutable Node runtime has no package-installation role. Exact image
# linkage identifies apt methods as its only GnuTLS consumers; Node uses OpenSSL.
# Purge apt and its dependencies together instead of leaving a broken TLS tool.
RUN apt-get update && apt-get install -y --no-install-recommends perl-base=5.36.0-7+deb12u4 \
    && apt-get purge -y --allow-remove-essential apt libapt-pkg6.0 libgnutls30 \
    && rm -rf /var/lib/apt/lists/* \
    && test ! -e /usr/lib/x86_64-linux-gnu/libgnutls.so.30 \
    && test ! -e /usr/bin/apt-get \
    && ! ldd /usr/local/bin/node | grep -q 'not found'
ENV NODE_ENV=production
WORKDIR /app
COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --chown=node:node scripts/operator-local.mjs scripts/connector-local.mjs scripts/verify-recovery-material.mjs ./scripts/
RUN rm -rf /app/node_modules/typescript /app/node_modules/@typescript \
    /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    && mkdir -p /run/dispatch /private-assets /bootstrap /journal \
    && chown node:node /run/dispatch /private-assets /bootstrap /journal \
    && chmod 700 /run/dispatch /private-assets /bootstrap /journal
USER 1000:1000
CMD ["node","dist/apps/api/src/local-digital.js"]
FROM runtime AS fixtures
COPY --from=fixture-build --chown=node:node /app/tests/payment/tooling/node_modules/@foundry-rs/anvil-linux-amd64/bin/anvil /app/fixture-bin/anvil
COPY --chown=node:node tests/containers/fixtures.mjs /app/fixtures.mjs
CMD ["node","fixtures.mjs"]
