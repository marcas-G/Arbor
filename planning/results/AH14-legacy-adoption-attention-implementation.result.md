# AH14 Legacy Adoption Evidence Attention — Implementation Result

Status: **scoped implementation and targeted qualification complete; no full-suite or release-closure claim**

Authorization: `AUTHORIZE_AH14_LEGACY_ADOPTION_EVIDENCE_ATTENTION_IMPLEMENTATION`

Fixed implementation plan: `planning/proposals/AH14-legacy-adoption-attention-implementation-plan.md`

Plan SHA-256: `C059F667341A6D5E10003B3D9769390F0F9EAFB3F383CBD739177EA833312D69`

Starting HEAD: `16b3fe8eee619934ef360822f921250284e47c59`

## Implemented

- Added offline-only migration 0047, `requiresUserVersion: 46`, and raised the runtime schema target to 47. P9 failure and resolution facts are permanent and immutable; the P10 marker remains rebuildable. Existing migrations and `docs/design/**` were not changed.
- Added canonical AH14 evidence/identity codecs, exact P4 `RecoveryBindingV1` and terminal-disposition validation, immutable `LegacyAdoptionEvidenceEscalated` / `LegacyAdoptionEvidenceResolved` facts and events, and current unexpired lease checks.
- On an ambiguous legacy action result, P9 leaves Step/actions/Session/settlement unchanged and returns blocked without another Provider request. Evidence-only resolution requires every decoded action to have exact same-step P4 binding and terminal disposition. The resolution event/fact, ProviderTurn evidence adoption, and Prepared→ProviderResultAvailable Step transition share one transaction; an exact retry returns the original fact.
- Added P10 exact event-envelope/fact validation, safe `LegacyAdoptionEvidenceInsufficient` Attention projection, marker/offset atomicity, resolution removal, and fact-snapshot rebuild that does not revive resolved markers after journal pruning.
- Extended offline schema-upgrade CLI and manifest hashing through 0047, including schema 46→47, ordered 44→47, final 47 read-only reopen/no-op verification, and prepared/commit restart handling. The 0047 descriptor SQL pin is `7cc51d23acee151a45f9949c11c0179543b8344ac97ac3894878e9d52b92e4c1`; the trusted schema-46 prefix signature is `b25426eeeead9607bfcb929931736caad7dfb7f2b73590dd6d7a7da0163650bb`.

## Qualification evidence

- Focused module run: 4 files, **25/25 tests PASS** — migration 2/2, ports 3/3, P9/P10 persistence 8/8, P10 read-model 12/12. Coverage includes exact NotAdmitted and Applied P4 evidence, missing-proof non-resolution, stale and expired lease rejection, P10 failure/resolution marker-offset rollback and commit, and prune/rebuild without resolved-row resurrection.
- Offline CLI targeted cases all PASS individually: fresh→47, 44→45→46→47, 45→46→47, 46→47, concurrent resume through 0047, and copied-target read-only reopen/no-op at 47. A first 46→47 run exposed a missing source-version allowlist entry; the follow-up exposed schema-46 verification falling through to the schema-38 template. Both were fixed, and the final 46→47 case passed 1/1 (52.699s). The copied read-only reopen case passed 1/1 (108.927s).
- Four real-process crash boundaries PASS: failure fact before commit 108.755s, failure fact after commit 84.379s, resolution before commit 132.194s, resolution after commit 131.781s. The resolution-before case initially revealed a test wait predicate that accepted a Pending action; it now waits for the durable `TerminalRejected` state. Resolution recovery retained one exact P4 denial invocation and one action, with no replay of the original ProviderTurn.
- Final static gates: `pnpm typecheck` PASS; Biome on 33 changed files PASS; `git diff --check` PASS.

Only disposable fixtures were used. No preserved/dogfood or live database was opened or changed. Full `pnpm test:functional`, full `pnpm check`, and the rest of the release suite were not run.
