# Security

Dispatch is an **experimental developer preview** for isolated Linux x86_64 development with generated PostgreSQL, EVM and wallet fixtures. It has not received an independent security audit and is not qualified for real customer payments or production use. Mainnet payments and physical ordering are disabled. Never supply funded wallets, production databases, live provider credentials or production secrets to the local tools.

## Reporting vulnerabilities

Use [GitHub's private vulnerability report form](https://github.com/RileyCreighton/dispatch-public/security/advisories/new) when it is available. If it is unavailable, request a confidential contact channel from [Riley Creighton](https://github.com/RileyCreighton) through an existing private conversation or, while repository access is restricted, a private repository issue containing only a contact request. Do not include vulnerability details in that request. Do not post exploit details, credentials or purchase capabilities in public issues.

A confidential report should include the affected version, reproduction using disposable data, expected and actual behavior, and impact. No response SLA or bounty is promised.

## Known limitations

Compiler provenance, build-chain and OS-image security findings remain unresolved, including high/critical findings. An npm metadata audit does not cover or close those findings. No vulnerability exception is approved. TypeScript 7.0.2 remains pinned; compatibility experiments do not qualify an alternative toolchain.

The container installation, real named wallets, live facilitators and production operations are not qualified. Local test results do not establish production security or money-acceptance readiness. Browser and server actions cannot be made atomic; already-started wallet outcomes require reconciliation.

## Payment and access guarantees

Settlement intent is durable before network submission. Unresolved purchases must retain their original authorization and exposure; they must not receive autonomous resubmission or a fresh authorization. Public transaction and signature data do not authenticate a buyer. Private delivery requires scoped authorization and exact immutable asset bytes. Provider verification alone does not establish payment. Refunds require explicit fresh wallet/operator authority and preserve purchased access under the current policy.

Security-sensitive changes require independent review and meaningful regression checks. Fixing a dependency or reproducing a local flow does not qualify unrelated artifacts or live systems.
