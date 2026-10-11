# EA-DG-01 — Post-Landing Review Repair

Date: 2026-10-11
Status: **Blocking finding repaired in owner contracts; independent re-review pending**

## Review finding

Independent post-landing review returned **Blocking = 1**: DID §9.3's 0038
rebuild replaced the `action_approvals` indexes but omitted the composite
`UNIQUE(action_approvals.approval_id, project_id)` introduced by migration
0033. The existing
`assign_work_target_bindings(action_approval_id, project_id)` foreign key
references that pair, so a rebuild without recreating its unique parent key
would leave the AssignWork FK contract unsupported.

## Exact repair

The accepted EA package already requires preserving earlier schema and the
AssignWork/CAPA route. No new semantic choice was required. Owner contracts now
explicitly recreate `action_approvals_id_project` in 0038 and state that it
supports the existing AssignWork target-binding FK. Migration 0033 and all
Control/AssignWork approval semantics remain unchanged.

Changed owner files:

- `docs/design/03-detailed-implementation-design.md` §9.3: add the composite
  unique index to 0038's explicit index set and explain the 0033 FK dependency.
- `docs/design/implementation/P1/04-sqlite-schema.md`: state the migration
  preservation contract.
- `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md`:
  record the FK-preserving rebuild constraint at the P4 storage owner.
- `docs/design/implementation/P1/00-contract-index.md` and
  `docs/design/implementation/P4/00-contract-index.md`: point to the preserved
  key and owner contract.
- `planning/results/EA-DG-01-contract-landing.md` and
  `planning/results/EA-DG-01-contract-landing.result.md`: record the review
  correction and refresh all affected owner hashes.

The complete post-repair owner SHA-256 manifest is in
`planning/results/EA-DG-01-contract-landing.result.md`.

## Scope and verification

- Only accepted EA design-owner contracts and their landing records were
  edited. No historical migration body, production code, test, `C:\Arbor`
  main tree, or Control behavior was changed.
- `git diff --check` is the only verification performed; no tests/builds were
  run. Re-review is required before treating the landing as review-complete.
