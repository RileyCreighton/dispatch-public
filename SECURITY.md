# Security

Dispatch is an **experimental developer preview**. It has not received a professional security audit and is not approved for real customer payments, mainnet spending or public money acceptance. Passing local tests is not security qualification.

Only isolated Linux x86_64 development with generated disposable PostgreSQL/EVM/wallet fixtures is supported here. Production secrets, funded wallets, cloud deployments, live provider credentials and raw production databases are unsupported and must never be supplied to these tools. Mainnet and physical ordering remain deliberately disabled.

## Known limitations

High/critical findings remain unresolved in the retained dependency, OS-image and build-chain assessments, including compiler provenance obligations. The retained ledger contains 273 unresolved occurrences across 42 advisory IDs; later raw scans have different subjects/counts and are not automatic closures. No vulnerability exception is approved. TypeScript 7.0.2 remains pinned; compatibility experiments do not establish security qualification of an alternative. Detailed assessment artifacts are not part of this source distribution.

Every release-producing runtime, build stage and test tool must be assessed. Scanner success and isolation alone do not waive high-consequence risks. Payment/authentication/private-data/build-integrity/recovery failures block qualification. Preserve failures and exact source/artifact identities. Fixes or not-affected determinations require evidence and independent review; residual risk requires explicit owner approval. Local approvals do not confer production or mainnet authority.

## Reporting

**Publication blocker: an owner-approved confidential reporting channel has not yet been established.** Before publication, the owner must configure and verify that channel and replace this paragraph with the exact instructions. No email address or GitHub reporting feature is assumed to exist. While access is restricted, reviewers must arrange a confidential channel directly with the repository owner. GitHub private vulnerability reporting is documented for public repositories; it is not assumed enabled for this private backup. Before making the source public, the owner must enable and verify it under Settings → Advanced Security → Private vulnerability reporting, or establish another verified confidential route. [GitHub setup instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). Do not publish exploit details, credentials or private purchase capabilities in a public issue.

Include the affected version, exact reproduction with disposable data, expected/actual behavior and impact. Maintainers should acknowledge, reproduce, triage and independently verify security-sensitive corrections before release. No response SLA or bounty is promised.

## Financial and access invariants

One initial settlement intent; no autonomous resubmission or second authorization for an unresolved purchase. Unknown stays pending/review, with original exposure retained. Public transaction/signature information is not buyer authentication. Scoped grants protect exact immutable asset bytes. Never infer payment from provider verification alone. Refunds require explicit fresh wallet/operator authority and preserve purchased access under the current policy.

Future production qualification must independently cover actual Base/native USDC, authenticated facilitator, RPC, named wallets, TLS/ingress, secret custody, backups, recovery, monitoring and dependency/image security. There is no supported production-enable shortcut.
