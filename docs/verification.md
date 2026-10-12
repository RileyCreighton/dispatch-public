# Verification scope

The native developer walkthrough tests actual PostgreSQL, the API, Chromium, a non-forked local EVM, the maintained upstream x402 client and worker functions with a generated facilitator fixture. It checks two distinct transactions, one authorization and signed submission per buyer, exact private bytes, unauthorized-download denial, same-purchase recovery and ordinary checkout during a real API outage.

The export is prepared for fresh independent review. Local execution does not establish independent acceptance, a security audit, production readiness or real named-wallet compatibility.

## Reproduce the checks

Use [Contributing](../CONTRIBUTING.md) for locked installation, root/web compilation, strict checking, source hygiene, unit checks and `scripts/test-all.py`. That runner executes the named selections in [tests/selections.json](../tests/selections.json) serially and records actual results privately. Selections overlap; do not sum them into distinct product requirements. The contention negative control is expected to fail at the competing-child diagnostic, not at setup.

`./scripts/demo.sh local` is the supported automated walkthrough. `python3 scripts/test-local-demo.py` checks complete repeat execution, exclusive-start refusal and interrupted-run cleanup. `scripts/test-hardening.py` covers native restore and diagnostic cases. `scripts/test-containers.py` is a separate real-container gate.

## Qualification limits

- **Container demo: not qualified.** A successful native run does not prove container installation, restart or fresh-volume restoration.
- **Security: incomplete.** Dependency metadata audits cover only their exact npm graphs; they do not close compiler provenance, build-stage, OS-image or high-risk security findings. No vulnerability exception is granted.
- **Remote CI: unverified until executed.** The included workflow is manual, pinned and non-deploying; no passing badge is asserted.
- **Live systems: not run.** Real wallets, Base/native USDC, authenticated live facilitators, production TLS/ingress, secrets, monitoring and disaster recovery require separate qualification.
- **Mainnet money acceptance: disabled and NO-GO.** Synthetic local settlement is not a money-moving production demonstration.

Keep failures and diagnostics private, and preserve exact source identities when reporting results. Source licensing and public visibility require owner decisions independently of these functional checks.
