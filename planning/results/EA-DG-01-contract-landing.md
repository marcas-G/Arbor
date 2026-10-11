# EA-DG-01 — Executable Approval Contract Landing

Date: 2026-10-11  
Status: **Accepted owner contracts landed; independent post-landing review pending**

## Fixed authority

- Accepted proposal: `planning/proposals/executable-approval-issuance-decision-draft.md`
- Accepted proposal LF SHA-256:
  `E4F1B2935E0397292049BB3FDB1AB5847B02443CCE1B55A9827F823C63F145EB`.
- Acceptance: `ACCEPT_EXECUTABLE_APPROVAL_ISSUANCE_DECISION_RESUME`, recorded
  in `planning/results/EA-DG-01-governance-acceptance.md` before the owner
  landing.
- Independent fixed-proposal review: **Blocking = 0**.
- The landing is limited to that accepted package under the user's standing
  authorization and the `AGENTS.md` governance delegation exception. Runtime,
  migration execution, tests, release qualification, and changes to
  `C:\Arbor` are not authorized by this landing.

## Migration order

The accepted owners remain ordered and unchanged: `0032` ActionApproval
convergence, `0036` AH7/P36 admission, `0037` AH10/P37 Deliver projection,
then new `0038_executable_approval_handoff`. Migration 0038 depends on all
three preceding contracts, may only apply after integrated 0036 and 0037, and
does not edit or renumber any existing migration. A `user_version=35` database
must first receive integrated 0036 and 0037. This landing introduces no slot
collision or change to P36/P37 semantics.

## Owner map

- System Design v1.14 / DID v1.39: common approval disposition, invariant,
  P4 nonterminal pause and ordered migration contract.
- MAC `00`/`02`: shared `Cancelled` lifecycle and strict Control/Executable
  route separation.
- P1: external `ResolveExecutableApproval`, human decision authority,
  command/CAS transaction, 0038 schema and durable event facts.
- P2: full-lease-fenced request issuance, Stop race/cleanup, pause and
  same-Execution recovery.
- P3: nonterminal pause and pinned same-Step/logical-action/tool-invocation
  resume and cursor behavior.
- P4: exact Runtime-owned binding, typed outcomes, legacy replay-only
  `Denied(ApprovalRequired)`, pre-effect claim contract, 0038 repository and
  compatibility rules.
- P6: route-specific Inbox admission, consumption and durable wake source.
- P9: AH7-compatible issuance/decision/Stop/crash/replay qualification matrix.
- P10: read-only bounded Inbox target view/query, not decision authority.
- P12: pure invocation/decision resolver inputs and human decision authority.
- P17: same-Execution wake without new Provider turn or conversation retry.

No unresolved owner conflict against the fixed accepted proposal was found.
Executable request identity, first-commit TTL, stable-field unique-conflict
readback, expiration, terminal dispositions, Stop cleanup, legacy retention,
human authority, and AH7 fenced consumption are allocated to the listed
owners. This is an owner-contract landing, not evidence of implementation or
qualification.

## Landing evidence

- Landing commit: `018f766a5a34f2fa8cc1108f09f10a73594dbd8c`.
- Post-landing owner file SHA-256 values and scope checks are recorded in
  `planning/results/EA-DG-01-contract-landing.result.md`.
- P36 owner contracts were present in this worktree before the EA landing;
  P37 remains accepted/planned and conditional on P36 integration.
- Independent post-landing consistency review remains required.
