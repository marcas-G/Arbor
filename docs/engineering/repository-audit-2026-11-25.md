# Repository audit — 2026-11-25

Read-only audit of master e7065a7cb06938a045a00d449b5b345f52cff8eb, ci-health-gates 0cc43cb8c40b3fad1df1089aa4003ecaa8e4a448 and linux-agent-delivery 2fceefc9ee8214c1a5d3b47732e95494f2cc16ca. Candidate governance base: the last revision, which contains both prior branches (25 commits ahead of master, 5 ahead of ci-health-gates; neither behind). Selection is for review, not a release or integration authorization.

## Findings and acceptance criteria

| ID | Evidence | Next action and acceptance |
|---|---|---|
| GOV-01 | Master AGENTS.md declares v1.9/v1.31 while design headers are v1.16/v1.42 and later agent entries mention v1.23/v1.61. Linux branch already removes the stale header duplication and uses design v1.27/DID v1.68. | Keep the Linux authority chain; standalone header/dependency check passes and detects mismatched versions in negative tests. Do not rewrite frozen clauses. |
| GOV-02 | Master tracks 1,925 planning files (801 results, 566 testing), 146 docs, 390 root tests files. planning/README originally enumerates P0–P12; many subsequent phases and evidence exist. | Index current vs historical vs active work; build reference graph before any move. All retained references and audit identities resolve. Do not delete evidence in this first change. |
| GOV-03 | Linux branch already has PROJECT_INTENT, CURRENT_STATE, ARCHITECTURE, KNOWN_PROBLEMS, OPEN_QUESTIONS, RELEASE_PROGRESS. CURRENT_STATE names 5068be6 plus uncommitted changes, not a clean qualification of this audited SHA. | Reconcile current facts to a clean commit, separate summary from dated checkpoints; no duplicate roadmap/status authority. |
| GOV-04 | Existing tests/architecture/package-dag.ts defines allowed edges, and package-dag.test.ts reads manifest edges and uses regex source checks. | Audit actual import graph with AST/resolver including type-only, export-from, literal dynamic imports and cross-package relative imports; compare declared edges to actual. Negative fixtures prove rejection; ratchet existing exceptions, no broad waiver. |
| GOV-05 | Linux model-decision.ts is ~292 KB and contains a large runModelDecision workflow with provider-turn/checkpoint/overflow/replay logic. Master also has large tool runtime, control actions, attention projection, migrations and schema upgrader. | Measure per-function complexity, state ownership and co-change on the candidate branch. First map duties and exact invariants; split one seam at a time under existing recovery, process and acceptance tests. No line-count-only target or semantic change. |
| GOV-06 | CI branch is already included in Linux branch. .github/workflows/ci.yml runs PRs on self-hosted Linux with full functional journey; master is reported unprotected and rulesets empty (detailed protection read denied). | Owner selects integration branch; design trusted isolated runner policy before opening/executing untrusted PRs. Verify required checks and branch protection settings; avoid duplicating current CI. |
| GOV-07 | Existing health policy blocks new P0 entries in KNOWN_PROBLEMS. A report of a pre-existing defect may therefore fail the same check as defect introduction. | Distinguish disclosure vs introduction with reviewable evidence; release blockers remain visible and block release, not their own documentation. Test both cases before changing gate. |
| GOV-08 | Linux delivery status describes preview/startup and partial real command evidence; full same-artifact qualification remains open. | Owner selects a clean candidate and verifies exact installation, real provider, file/command, independent verification/acceptance, recovery and upgrade scope. No release claim from this audit. |

## Sequence

1. Adopt repository governance and development guide by owner review.
2. Reconcile integration branch and runner safety before enabling merge checks.
3. Reconcile current-state and design-chain metadata; create a read-only inventory and link audit.
4. Strengthen actual source dependency checks and ratchet violations, using the existing architecture suite.
5. Review and refactor runtime hotspots individually, using behavior-preserving recovery tests and exact candidate evidence.
6. Qualify a release on one clean artifact and source baseline.

This is a bounded static review, not a full scan of every source or document, and no repository test or release run is claimed. All findings refer to the stated revisions. The recommended gates do not take effect by writing this audit.
