# EA-DG-01 — Executable Approval Governance Acceptance

Date: 2026-10-11

Accepted decision: `ACCEPT_EXECUTABLE_APPROVAL_ISSUANCE_DECISION_RESUME`

Status: **ACCEPTED; exact owner-contract landing authorized; implementation remains gated**

## Accepted fixed package

- Proposal: `planning/proposals/executable-approval-issuance-decision-draft.md`
- Accepted proposal LF SHA-256:
  `E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`
- Semantic source baseline: accepted AH7-DG-03 landing
  `5cab270642f3a738f1da3dcb846ce734d477f8b2`.
- Independent review outcome supplied by the coordinating agent:
  **Blocking = 0** for the fixed proposal at the hash above.
- The user’s standing authorization permits Codex to apply a sufficiently
  specific, accepted governance package to `docs/design/**` under the
  `AGENTS.md` manual-governance delegation exception. This exact fixed package
  is accepted under that authority; this record does not accept any later
  semantic changes discovered during landing.

The accepted outcome preserves MAC's shared ActionApproval lifecycle while
adding the route-specific Executable issuance/decision/resume contract.
Control/CAPA approval identity, API and semantics remain unchanged.

## Migration ordering decision

The existing slots are preserved:

| Version | Existing owner / use | Status in this landing |
|---|---|---|
| 0036 | AH7/P36 ToolInvocation admission schema | Accepted AH7 migration; not rewritten or renumbered |
| 0037 | AH10 Deliver P9 fact + P10 source-specific projection marker | Accepted/planned forward migration, conditional on integrated P36; not rewritten or renumbered |
| 0038 | EA-DG-01 Executable ActionApproval extension | Newly allocated by this accepted package |

Migration `0038_executable_approval_handoff` depends on the unchanged
ActionApproval convergence in `0032`, AH7/P36 `0036`, and the preceding AH10
Deliver migration `0037`. It is forward-only and may be applied only after
`0036` and `0037` are integrated in order. It must not modify migration `0032`
or any prior migration. Deployments at `user_version=35` must apply the
integrated `0036` and `0037` before `0038`.

This allocation follows the existing AH7/P36 and AH10/P37 planning records,
including `planning/results/AH7-DG-03-implementation-l1.result.md` and the
AH10 Deliver decision `C:\Users\ThinkPad\.codex\worktrees\ah10-deliver-governance\Arbor\planning\results\AH10-deliver-p10-storage-addendum-governance-decision.md`.

## Exact landing scope

Only the fixed proposal's owner contracts and indexes are authorized:

- DID / System Design common approval disposition and invariants;
- MAC `02` and `00` index;
- P1 external command/authority/event and migration contract;
- P2 Stop transaction composition and fencing boundary;
- P3 durable same-Step/action pause and resume;
- P4 exact Executable approval binding, typed outcomes, legacy replay and
  migration `0038` contract;
- P6 Inbox admission/consumption/wake;
- P9 recovery and AH7 AP qualification extension;
- P10 Inbox view/query and route projection;
- P12 pure resolver and decision-authority inputs;
- P17 same-Execution recovery/wake;
- owning contract indexes, version references, and landing/result records
  needed to identify these exact changes.

The accepted proposal SHA and this decision record remain immutable evidence.
If landing discovers an unresolved semantic conflict, stop that owner edit and
record the conflict for manual governance rather than expanding this package.

## Explicit exclusions

This acceptance authorizes design-contract landing only. It does not authorize
production code, migrations or database execution, test changes, preserved
database recovery, deployment, push, or merge. Those remain separately gated
by the landed contracts and their implementation qualification plan. No tests
were run to create this decision record.
