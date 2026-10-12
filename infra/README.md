# Local infrastructure

The container launcher is `./scripts/demo.sh up` from the repository root, but its complete flow remains CHANGES REQUIRED. Use `./scripts/demo.sh local` for the automated native developer walkthrough. Read [getting started](../docs/getting-started.md) first.

`compose.digital.yaml` defines the isolated digital application with fixed local fixture endpoints. `Caddy.digital` refuses operator routes; the demo configuration forwards buyer traffic and the API rejects proxied operator calls. The fixture browser transports operator requests through a private Docker-exec loopback bridge while buyer traffic uses the **loopback-only** published port. `compose.yaml` is the smaller foundation topology used by negative isolation checks; it is not the digital product demo.

Images and build inputs remain pinned, including TypeScript 7.0.2 and the Caddy source/Go module patch. No image is security-qualified by its digest alone. High-risk build/runtime findings remain open. The Caddy source is built with the checked-in module graph; keep upstream and changed-file notices with any distribution.

The launcher uses unique project names, read-only root filesystems, no-new-privileges, dropped capabilities, resource limits, internal networks and generated local material. Private assets are read-only on API. No privileged host installation, system certificate changes, broad Docker prune or live secrets are part of setup.
