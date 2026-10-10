# AH10 Deliver P10 Storage Addendum — Design Landing Result

Date: 2026-10-11
Status: **Design owner landing complete; independent post-landing review pending**

## Decision and authority

- Accepted addendum proposal LF SHA-256:
  `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
- Acceptance marker: `ACCEPT_AH10_DELIVER_P10_STORAGE_ADDENDUM`.
- The exact fixed addendum received independent review **Blocking = 0** before
  acceptance. The accepted decision is recorded in
  `planning/results/AH10-deliver-p10-storage-addendum-governance-decision.md`,
  committed separately at `d5649e9c74ed274fb3c05ea8246db33b326dc60d`.
- The original AH10 Deliver proposal remains separately identified by accepted
  SHA-256
  `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565`.
  Its DID v1.37 landing is historical input; this addendum corrects only the
  two post-landing blockers and does not claim AH10 closure.
- Landing commit:
  `129782081677041526ef92be27c0a5f472f48bb2`.

## Exact owner changes

- DID v1.38 updates §4.1B (no Gateway/ordinary SendMessage change), §7.2 (no
  new generic port), §9.3 (ordered migration prefix and P10 marker DDL), and
  §12.10 (P9/P10 source ownership). It records Deliver-specific P10 marker
  storage and that P37 is conditional on integrating accepted P36.
- P9 `07`/index retains all P9 fact identity/event/failure/transaction
  semantics and designates `listDeliverReplayFailures(projectId)` as P10's
  fact-backed rebuild source.
- P10 `02`/`04`/`07` and index define the Deliver marker/FK/dedup and exact
  query union, marker+offset consumer transaction, fact-snapshot/seed/offset
  rewind rebuild transaction, and Story M qualification. Existing AssignWork
  projection schema/rows, F21 rebuild-refusal behavior, and P36 contract are
  preserved.
- P36 is accepted and has isolated L1 evidence, but is **not integrated** in
  this AH10/mainline tree; inspected migration registry is at P35/user_version
  35. Evidence: AH7 design landing `34ed1c597c02d677d87f4fa9435d8339641ea3d6`,
  acceptance/landing record `5cab270642f3a738f1da3dcb846ce734d477f8b2`, and
  isolated implementation/L1 commit
  `fa732378e32e8949d39fa68b637418c2b6939e99`; result files are under
  `C:\Users\ThinkPad\.codex\worktrees\ah7-approval-atomicity\Arbor\planning\results\`
  (`AH7-DG-03-governance-acceptance-and-landing.review.md` and
  `AH7-DG-03-implementation-l1.result.md`). Thus P37 is not authorized for
  standalone implementation/release; v35 must receive integrated P36 before
  P37.

## Post-landing owner file SHA-256

| Owner file | SHA-256 |
|---|---|
| `docs/design/03-detailed-implementation-design.md` | `EF89E6FC4A2A4A1B6D249CD263C4FDD332A19AD7B603FD0FF72381870039D148` |
| `docs/design/implementation/P9/00-contract-index.md` | `7EC41D55C57FD12A36BDC8F0F11E460AADA8551C36AF11B4AD2E1238CDFF7F5F` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `B6F1B09CC16DF432F56D9F2CBF1836F56AF3D6852048C07E31DA089ECCC859D4` |
| `docs/design/implementation/P10/00-contract-index.md` | `50116E11BFA377F8CE595FE3F7BA8BF2184C7EF242A1133789F81AE15B1E64E2` |
| `docs/design/implementation/P10/02-attention-readmodel.md` | `64281F726CB5BEAA9DB644F78D2E52EDA56770BE9AB445FC7FFFED34E87DBD29` |
| `docs/design/implementation/P10/04-rebuild-atscale.md` | `6423A65D76D91B8826A14211CE808971A18233B92EAA09763AD0A0BFF1819AC8` |
| `docs/design/implementation/P10/07-acceptance.md` | `65728AA14DA9786A8AA60EC33568C9DA0DC4AAF47A011B5933A33293204396C1` |

## Scope and verification

- `git diff --check` and commit whitespace check passed.
- No production, migration implementation, or test files changed.
- No tests or full gates were run.
- This is not the required independent post-landing consistency review,
  runtime qualification, migration qualification, or AH10 phase closure.
