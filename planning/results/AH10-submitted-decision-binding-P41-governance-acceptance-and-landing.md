# AH10 Submitted DecisionEpisode Binding — P41 Governance Acceptance and Landing

Date: 2026-10-11
Status: **DESIGN LANDING COMPLETE; independent post-landing review pending**
Implementation/migration/test authorization: **not granted**

## Fixed decision and authority

Decision: **ACCEPT** the fixed AH10 Submitted DecisionEpisode binding failure
proposal as P41. Accepted proposal:
`planning/proposals/agent-loop-submitted-binding-rejection-terminalization-draft.md`.
Its SHA-256 over LF UTF-8 bytes is
`10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A`.
This is the accepted source blob; its historical DRAFT/review-status header was
not rewritten after acceptance.

The manual governance instruction in the current task invokes the standing
2026-10-01 delegated-landing authorization in `AGENTS.md`. The reported
independent proposal review is **Blocking = 0**. No separate review file or
review SHA was supplied in the unified tree/task payload; this record preserves
that provenance limitation rather than manufacturing a review artifact.
Implementation, migration implementation/registration/execution, tests,
qualification and release still require their own authorization and evidence.

## Baseline and selective planning import

Landing base was the clean unified governance branch
`codex/governance-p36-p40@b1a7efc07debd92704ec09f0fde5b2869445c716`, containing
the integrated P36–P40 design and final design review at Blocking = 0. The
independent P41 source history was selectively imported as planning-only
commits `cb7f898cb88817d2e2d448b3c8820b7e88e0b6bd`,
`920b611819563be99d8308fb4d21afed38ad81c8`, and
`e845e54779726e5a279cdfa47798e2a190950ac6`: proposal, result, and the isolated
pending RED. No P39 baseline commit, production source, actual migration, or
qualification implementation was imported. Only the pending RED extension was
imported; it remains under `tests/functional/pending/` and was not run. The
proposal/result/RED LF SHA-256 inventory at owner landing is:

| Planning artifact | LF SHA-256 |
|---|---|
| Fixed proposal | `10D5A2532810B65DFBD3E397B141F6C0765AD32F4992BDDD0FE17F468975339A` |
| Result record | `E25247B99EBB1368BE0707A3148758FE12BE6D23EABE0ACEBB02C0AF756D56E4` |
| Pending RED | `8C4ABE98A74ED239AD729E6FDCEE190A20E2A868B1DF1B4CE238EAFF37F11B0C` |

P36/0036 through P40/0040 are accepted owner/design contracts in the unified
tree but are not thereby claimed implemented, registered, integrated in a
runner, or qualified. P41 is fixed as **P41 / migration 0041**, targeting DID
v1.42 after unified DID v1.41. 0041 is conditional: it cannot be integrated,
registered, implemented, run, skipped, or released until the entire
0036→0037→0038→0039→0040 prefix is integrated and qualified. No earlier
migration body, number or checksum is rewritten. System Design remains v1.16;
the accepted proposal changes no upstream P5/EGP DecisionEpisode semantics.

## Landed owner disposition

- **P3 `08`:** exact Submitted DecisionRequest Workspace and settled Provider
  result/Step Manifest mismatch is classified before replay. P3 returns a
  typed mismatch or a pure Stop-only close plan; it has no P9 store dependency.
- **P9 `07`:** owns `SubmittedDecisionBindingEscalated(v1)`, the immutable fact,
  current-full-lease fencing, repeatable RecoveryBlocked, legacy settled orphan
  audit, and duplicate-writer idempotency. The source identity is exact
  `(executionId, logicalStepNo, repairAttempt, logicalActionId)`.
- **P2 `06` and P9 Recovery/Application composition:** only existing authorized
  StopExecution resolves the active slot. With the complete current unexpired
  lease and no unresolved P4 side effect, the cross-store coordinator reuses or
  atomically creates the P9 fact/event and applies the P3 plan in one
  TransactionScope. P3 early settlement uses existing
  `TerminalRejected(StopRequestedAfterSubmittedBindingFailure)`,
  `SkippedEarlySettlement`, and
  `SettlementProposed(Interrupted(StopRequested))`. P2 RecoveryController
  settles only that persisted proposal. Fact-first and Stop-first serialize;
  Attention/fact and the old receipt/canonical selection remain unchanged.
- **P9 old-row audit:** exact already-settled Failed DecisionEpisode with
  `ActionsInProgress` and cursor Pending `select_current_work` is the scan
  trigger, even if the mismatch was later repaired. Use the still-provable
  mismatch code or `SettledExecutionWithPendingDecisionAction`; add Attention
  only, never reopen or repair. Unprovable identity follows existing
  insufficient-evidence handling.
- **P10 `02`/`05`/`07`:** source
  `SubmittedDecisionBindingFailure`, one safe `ActionRequired` row targeted to
  the authoritative Execution Workspace, deduped by `attentionFactId`, with no
  public failure code or DTO/route widening. Story P records module, old
  receipt/old generation/full lease, Stop/fact, legacy audit and two-daemon
  qualification requirements.
- **P10 `04`:** source-specific full rebuild atomically resets this marker,
  snapshots/seeds P9 facts and rewinds the P1 Attention offset to
  `floor - 1` in the same `BEGIN IMMEDIATE`/`TransactionScope`. P9 event id and
  P10 marker do not FK to prunable `domain_events`; marker remains FK-bound to
  its fact. The contract covers duplicate consumption, pruned-event rebuild,
  both rebuild crash boundaries, and fact creation on both sides of the rebuild
  writer lock. P1 retains ownership of the journal floor.

## Owner package hashes

SHA-256 is computed over each owner file's UTF-8 bytes after CRLF→LF
normalization (the committed Git blobs are LF). These exact landing hashes are
recorded after owner edits:

| Owner file | LF SHA-256 |
|---|---|
| `docs/design/03-detailed-implementation-design.md` | `545968CF05C6E022A60385E2E4C86B744BAC03D91750268F24BB6E7213FCF1DA` |
| `docs/design/implementation/P2/00-contract-index.md` | `F3313A82358A3DE215C676CF1A3BC11E25DB0D3105B766DA8A5CEABC5F312B58` |
| `docs/design/implementation/P2/06-recovery-skeleton.md` | `83D8D274389D6A19A6A33191B0BB490D461EC5493B8F37F1C0879892059376BC` |
| `docs/design/implementation/P3/00-contract-index.md` | `7A972B6842AF47263D47A146AE68F65764C4961EBDF65D873D2E223253C6D165` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `FBECEE3600B71F04CF2C20FB173A155EFB165C71559E09578CF5BCA3F16D0931` |
| `docs/design/implementation/P9/00-contract-index.md` | `C057BCE842AD1A4EDC01B96F1792C0E2175EB5EA600F74F9AEB4A6446F1C4934` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `2B91FBAEF7445C65CC5BF096DB13B9CA1A5FBE902F9C73649363732474C4B72B` |
| `docs/design/implementation/P10/00-contract-index.md` | `543CFFE3D3A3DAAD9435392883C9AE94424F60EC87C6BEBD08A3945202F7DAFE` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `1CAD62016019C48E5103DCBB9DE5905FD9425E2FD5BE02E3E36DEAA26DB6E886` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `8AD289A6280B1F270B8B7C47AE6C4BE3B63CBD8FC0FF0E9A4A831B3B26CF9100` |
| `docs/design/implementation/P10/05-surface-actions-transport.md` | `0B34ACA9995A8C946D1125DB5A76C78A268E8A9E4104A37865F0870D6EACDE45` |
| `docs/design/implementation/P10/07-acceptance.md` | `38A01C31D5302E25B7FF7C6AF03ED61BB9C9E1B00961765BB7D44D272279DEFB` |

## Verification and boundary

The fixed proposal LF SHA was recomputed from the working file and matches the
accepted value above. Owner hashes above were computed after normalization.
The independent post-landing review is complete: **Blocking = 0; all 12 owner
hashes matched** the recorded LF SHA-256 values. The P41 design landing is
therefore closed. The source-only diff audit and owner consistency review are
complete; `git diff --check HEAD^ HEAD` passes after LF normalization. No full
test/check suite, pending RED, daemon, migration runner, production
implementation, or push was run. This closure does not claim P41 implementation
or AH10 implementation/qualification closure.
