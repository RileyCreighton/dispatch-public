# Proposed license preparation

**PUBLIC DISTRIBUTION BLOCKED: owner approval is pending.** `Apache-2.0.proposed.txt` is the complete, unmodified Apache Software Foundation text. It is a proposal, not an active grant for Dispatch. The root LICENSE and NOTICE intentionally record that distinction.

Before publication, the owner must confirm the copyright holder and project attribution, approve the license, and finish the dependency review in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Then replace the root pending LICENSE with the approved full text, finalize NOTICE, and use the exact SPDX identifier `Apache-2.0` for applicable project metadata and new project source headers (`SPDX-License-Identifier: Apache-2.0`). Do not overwrite third-party license headers or label their code as Dispatch-owned. Existing fixture headers retain their recorded terms.

Preserve copyright, patent, trademark and attribution notices required by upstream material. Include a copy of applicable licenses with redistributions and retain relevant NOTICE content. Mark modifications where upstream terms require it. MIT/BSD/ISC/0BSD notice retention and MPL file-level source obligations still apply alongside an approved project license. A permissive package label is not evidence that every bundled binary or transitive component is cleared.

The npm inventory covers all locked occurrences, including duplicates and optional platforms. Collected texts are hash-bound in `npm-inventory.json`. The upstream inventory supplements 12 packages with exact source texts; `react-remove-scroll-bar` 2.3.8 remains unresolved. Each record states its actual source binding. No dependency binary, image or browser is distributed in this source tree; distributing those artifacts would require their own complete notice and source-obligation review.

Primary references: [Apache-2.0 terms and application guidance](https://www.apache.org/licenses/LICENSE-2.0) and [Mozilla MPL distribution guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/). The declared license inventory is compatible in principle with separately licensed project files, subject to each component’s obligations; it is not a completed legal clearance or an owner license grant.

## Decision prepared for the owner

Proposed project license: **Apache-2.0**. Approval must identify the project copyright holder and confirm the final NOTICE attribution. Until that decision, the root LICENSE grants no Apache license and public distribution remains blocked. Approving a project license does not relicense dependencies or waive their attribution obligations.

Before public visibility, resolve the remaining exact-version notice for `react-remove-scroll-bar` 2.3.8 and obtain independent source/attribution review. A source-only developer preview does not distribute installed dependencies or container/browser binaries; any future bundled artifact needs a separate complete notice and source-obligation review.
