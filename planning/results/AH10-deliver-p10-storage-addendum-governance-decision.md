# AH10 Deliver P10 Storage Addendum — Governance Decision

Date: 2026-10-11
Accepted decision: `ACCEPT_AH10_DELIVER_P10_STORAGE_ADDENDUM`
Status: **ACCEPTED; exact owner-document landing authorized under delegated user authority**

## Accepted fixed package

- Addendum proposal LF SHA-256:
  `040789D32BE1D92F1BAD28C5E3346439C1E902236452E778CD104AF6AA71EC8B`.
- Addendum source:
  `planning/proposals/AH10-deliver-generation-fence-p10-storage-addendum-draft.md`.
- This acceptance is additive to, and does not replace, the original AH10
  Deliver accepted proposal SHA-256
  `75EAF29FC8FC90C5E098DA3758EFAD8C69074F478C82F2399619F522AE596565` or its
  DID v1.37 landing. It corrects only the migration-order/integration-status
  and P10 Deliver projection-storage blockers.
- Independent review outcome supplied by the coordinating agent:
  **Blocking = 0** for the fixed addendum at the hash above.
- The user’s standing instruction authorizes Codex to apply an exact accepted
  governance package to `docs/design/**` under the AGENTS.md manual-governance
  delegation exception. No new per-change authority is inferred beyond this
  exact package.

## Exact landing scope

After this decision record is committed, land only the addendum's listed owner
corrections:

- DID v1.37: state the accepted/planned ordered prefix and that P36 is accepted
  but not yet integrated in the AH10/mainline tree; make Deliver migration
  `0037` conditional on P36 integration; define the source-specific P10
  projection relation, FK/dedup/query union, P9-fact rebuild source, and
  P1-offset atomic boundary.
- P9 `07` and its index: keep the accepted P9 fact/event semantics while
  recording the post-P36 forward migration `0037` and the source-fact list
  used for P10 rebuild.
- P10 `02`, `04`, `07` and its index: use the Deliver-specific marker table
  joined to the immutable P9 fact; define query union and reset/fact-seed/
  offset-rewind atomicity; add only the specified qualification rows while
  preserving the AssignWork table/rows and accepted F21/AH7 P36 contracts.
- Update DID/P9/P10 indexes, version/digest references and landing result only
  as required to record these exact owner changes.

No other owner semantics are authorized. In particular, do not change P1/P2/P7
or ordinary SendMessage/MessageSent semantics, and do not edit, renumber, or
replace migrations `0034`, `0035`, or `0036`. P36 remains unmerged in the
integrated tree; `0037` is not independently implementable or releasable, and
an existing `user_version=35` deployment must first receive integrated P36
before P37. Implementation, migrations, tests, deployment, and full gates are
outside this decision.

## Required landing audit

The landing result must list changed owner files, their post-landing SHA-256,
the landing commit, diff-check result, and explicit no-tests/no-production
scope. An independent post-landing consistency review remains required; this
decision does not claim DID/P9/P10 landing completion or AH10 closure.
