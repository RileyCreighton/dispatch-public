FROM node:24.21.0-bookworm-slim@sha256:51b1100cc2a83d370c6a60952e3f2989c8a43159d0e38586e090f3b3326efefd AS security-build
RUN apt-get update && apt-get install -y --no-install-recommends perl-base=5.36.0-7+deb12u4 ca-certificates=20250419~deb12u1 openssl=3.0.22-1~deb12u1 libssl3=3.0.22-1~deb12u1 && rm -rf /var/lib/apt/lists/*
# This stage runs apt, tar and Go only. Do not retain unused npm/Yarn tooling.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
ADD --checksum=sha256:42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d https://go.dev/dl/go1.26.9.linux-amd64.tar.gz /tmp/go.tar.gz
ADD --checksum=sha256:86e39de5fa0bc433a9cd574a00e7751059903401f3389c61f8937fd0ad0180f5 https://codeload.github.com/caddyserver/caddy/tar.gz/refs/tags/v2.11.7 /tmp/caddy.tar.gz
RUN tar -xzf /tmp/go.tar.gz -C /usr/local && tar -xzf /tmp/caddy.tar.gz -C /tmp
WORKDIR /tmp/caddy-2.11.7
COPY infra/caddy-security/go.mod infra/caddy-security/go.sum ./
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local GOMAXPROCS=2 CGO_ENABLED=0
RUN test "$(go version)" = "go version go1.26.9 linux/amd64" \
    && go mod verify && go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/caddy ./cmd/caddy
FROM caddy:2.11.7-alpine@sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229 AS runtime
# Same Caddy application source, narrow x/net patch and fixed Go toolchain.
COPY --from=security-build /out/caddy /usr/bin/caddy
COPY --from=security-build /tmp/caddy-2.11.7/LICENSE /usr/share/licenses/dispatch-caddy/LICENSE
COPY --from=security-build /usr/local/go/LICENSE /usr/share/licenses/dispatch-caddy/GO-LICENSE
COPY --from=security-build /root/go/pkg/mod/golang.org/x/net@v0.60.0/LICENSE /usr/share/licenses/dispatch-caddy/X-NET-LICENSE
RUN test -z "$(getcap /usr/bin/caddy)" && /usr/bin/caddy version
COPY --chown=1000:1000 edge-web/ /srv/
USER 1000:1000
