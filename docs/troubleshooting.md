# Troubleshooting

The native helper prints a failed phase and the exact private diagnostic directory. Keep generated logs, session material and database state out of issues and source control. A failed or ambiguous payment is never permission for another authorization.

| Symptom | Action |
| --- | --- |
| Node/npm version mismatch | Use exactly Node 24.21.0 and npm 11.19.0 on PATH. See [tool setup](getting-started.md). |
| PostgreSQL missing | Install PostgreSQL 17 binaries; set `DISPATCH_TEST_PG_BIN` to their directory. Run as an ordinary user. |
| Registry/browser download failure | Restore public dependency access and rerun setup. Preserve the failed attempt. Do not alter lockfiles or integrity checks. |
| Damaged installed dependencies | Remove only `.local/native-dependencies.json` and rerun the helper for a clean locked installation. |
| Browser cannot launch | Prepare Chromium's Linux libraries and NSS `certutil`. `--headed` additionally needs X11/XWayland `DISPLAY`; the default is headless. |
| Browser certificate or wallet missing | Use the helper's managed browser; a separate browser has neither its generated trust profile nor its fixture wallet. |
| Port occupied / validation active | Wait for the active run or stop its known owner. Do not kill an unknown process. Native tests use fixed loopback ports and run serially. |
| Insufficient disk space | The native startup floors are 2 GiB in the checkout filesystem and 512 MiB in `/tmp`. Manage your own completed outputs; the helper never prunes unrelated data. |
| Pending or failed purchase | Preserve the result. Recover only the same purchase using its original journal or buyer grant. Do not sign again or fake a receipt. |
| Missing private asset | Restore exact immutable bytes and manifest. A same-named replacement is not equivalent. |
| Wrong wallet or network | Only generated local wallets are supported by this demo. Do not supply real keys, a funded wallet or a production RPC URL. |
| API connection failure | Preserve diagnostics; connection failure propagates without replaying the transaction. Never lengthen transaction limits or retry payment to manufacture success. |

## Container investigation

`./scripts/demo.sh doctor` and `./scripts/demo.sh status` inspect the separate container environment. It is **not qualified** for this revision. Missing Docker is a blocked test, not a pass. Prepare a rootless Docker host with more than 20 GiB available in the actual store; do not change socket permissions or use a privileged daemon to bypass checks.

`down` preserves owned volumes and generated material; `up` resumes that same state. `reset` removes only the helper's exact synthetic project and retains diagnostic state. Never reset a pending purchase to claim it settled. Keep keys, TLS material, assets, chain state and database volumes together; loss of the temporary state directory is outside the container demo's persistence guarantee.

Full container restart and fresh-volume recovery remain unverified here. Worker readiness requires a recent heartbeat, and chain/facilitator loss should keep payments paused. A real-provider API key is not a workaround for the preview's intentionally disabled mainnet path.

Use [verification scope](verification.md) and [Contributing](../CONTRIBUTING.md) for reproducible checks. Local fixtures, browser tests, containers, named wallets and production acceptance remain separate categories.
