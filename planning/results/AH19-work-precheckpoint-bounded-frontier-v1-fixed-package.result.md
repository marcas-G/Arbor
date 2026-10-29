# AH19 Work Pre-Checkpoint Bounded Frontier — Fixed Package Record

Status: **PROPOSED FOR MANUAL GOVERNANCE; NOT ACCEPTED.** Planning-only
artifact. No `docs/design/**`, production, test, or migration file was changed.

## Package identity

- Base HEAD: `367fd9a3d064409b77b03bcab4ba26703d0a32b8`.
- Proposal: `planning/proposals/AH19-work-precheckpoint-bounded-frontier-v1-fixed-package.md`.
- Raw proposal SHA-256: `4692895A2C9CF92DB1308507F29ED288FD3149F944AAC4F3D8BAE23635F5D663`.
- Recommended manual token: `ACCEPT_AH19_WORK_PRECHECKPOINT_BOUNDED_FRONTIER_V1`.
- Mutually exclusive complete-coverage alternative:
  `ACCEPT_AH19_WORK_PRECHECKPOINT_COMPLETE_COVERAGE_V1`.

## Fixed decision

The proposed policy keeps the Session Timeline append-only and complete while
making the pre-first-checkpoint provider projection explicitly bounded to the
latest 64 persisted Session Timeline rows by sequence. P3 then applies exactly
its existing typed-projector branches and filters; filtered rows do not cause
older rows to be pulled into the window and are not claimed covered by the
projected context or checkpoint. The current pinned input and canonical Work
facts are injected separately and do not consume row slots. The package also
requires per-request assertions for the separate Work Objective, Constraints,
CompletionExpectation, VerificationMissionSummary, ResponsibilityDefinition,
ResourceBoundary, effective Authority/Permission, and other C0/C1 pinned facts.
Older rows remain durable but are outside automatic context and any checkpoint
coverage claim. Once a typed checkpoint exists, the frontier is the exact
checkpoint sequence plus every unsummarized row after it; budget pressure
triggers explicit compaction.

The qualification matrix also requires a real-checkpoint/restart combination
with a valid current P3-filtered HumanConversation UserMessage at the edge of
the 64-row window. It distinguishes `inputFrontier` as the examined row range
from actual `contextRefs`/compaction coverage and keeps the filtered row
durable but unprojected.

The package aligns with System Design's durable-Timeline/active-projection
separation and DID's Checkpoint + Recent Frontier, retention, and compaction
contracts. It recommends owning-document updates only after manual acceptance.
It does not authorize production changes, a migration, or AH19 closure.

## Verification and boundary

- Raw SHA-256 was computed over the saved proposal bytes.
- Whitespace check: `git diff --no-index --check -- /dev/null <new-file>`
  reported no whitespace errors. Exit code 1 is expected because each new file
  differs from `/dev/null`; Git emitted only its configured LF-to-CRLF
  normalization advisory.
- No tests or builds were run; no files were staged or committed.
- This result records the fixed package, not its acceptance or implementation.
