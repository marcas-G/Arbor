# AH10 Deliver P10 Storage Addendum — Draft Result

Status: **DRAFT; awaiting separate acceptance and independent review**

This record documents only a fixed governance correction addendum. It does not
change the accepted design, authorize implementation, or claim AH10 closure.

## Baseline and review finding

- Original AH10 Deliver proposal accepted SHA-256:
  `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`.
- The original landing is commit
  `89d799025e0633aebd9e4299df172907f14cc05e` (DID v1.37 and owner-document
  edits). The parent-reported post-landing review has **Blocking = 2**; this
  addendum records those findings as unresolved until a new acceptance and
  post-landing review.
- Blocking corrections covered here: preserve the accepted migration prefix
  `0034` P10, `0035` F21, and the accepted-but-not-yet-integrated `0036`
  AH7/P36 migration before Deliver's forward `0037`; and avoid using the
  AssignWork-specific P10 source/failure/FK table for Deliver by projecting
  through `deliver_replay_attention_rows` linked to the P9 fact. Mainline and
  the inspected AH10 tree are currently at P35/user_version 35. The P36
  acceptance/landing record is commit
  `5cab270642f3a738f1da3dcb846ce734d477f8b2`; accepted owner design landed at
  `34ed1c597c02d677d87f4fa9435d8339641ea3d6`; isolated P36 implementation/L1
  is commit `fa732378e32e8949d39fa68b637418c2b6939e99`. Evidence paths:
  `C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor\planning\results\AH7-DG-03-governance-acceptance-and-landing.review.md`
  and `C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor\planning\results\AH7-DG-03-implementation-l1.result.md`.
- P37 is conditional on P36 landing in the target integration and MUST NOT be
  independently implemented, installed, or released. An existing v35 database
  must first receive P36, then P37.
- The addendum proposal SHA-256 is:
  `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
- Suggested separate acceptance marker:
  `ACCEPT_AH10_DELIVER_P10_STORAGE_ADDENDUM`.
- Implementation authorization: **not granted**.

## Fixed draft correction

The proposal is
[`AH10-deliver-generation-fence-p10-storage-addendum-draft.md`](../proposals/AH10-deliver-generation-fence-p10-storage-addendum-draft.md).
It fixes the accepted/planned append-only migration sequence and conditional
v35→v36→v37 / v36→v37 paths after P36 integration;
defines a Deliver-specific P10 projection marker with P9 fact FK and
attentionFactId dedup; specifies the query union, P9-fact-driven rebuild and
P1 offset transaction boundary; preserves existing AssignWork rows and the
F21/AH7 P36 contracts; and lists the owner-document corrections and future
qualification matrix.

The DID/P9/P10 landing changes listed in the proposal are conditional on
separate acceptance. The original v1.37 landing is audit history, not a
substitute for that decision. No production, migration, or test work is
authorized by this record.

## Scope and validation

- Changed files: this result and the draft addendum proposal only.
- No `docs/design/**`, production source, migration, or test files changed.
- No tests or full gates run.
- `git diff --check` and commit whitespace checks passed for this correction.
