# AH7-DG-03 Governance Acceptance and Landing Record

Date: 2026-10-10  
Accepted decision: `ACCEPT_TOOL_APPROVAL_SETTLEMENT_ATOMICITY`  
Status: **ACCEPTED; exact owning-document landing authorized by delegated user authority**

## Accepted package

- Accepted proposal SHA-256 (LF source):
  `E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`
- Proposal source commit on the isolated worktree:
  `ce08b55` (`governance: accept AH7 approval settlement contract`)
- Base commit: `6fcbc17e27b694f201792aedd6c2ec368508b542`
- Worktree branch: `codex/ah7-approval-settlement-governance`

The accepted decision selects pre-effect, exact-invocation approval
consumption. The claim transaction atomically persists the exact P4 intent and
consumes the matching approval. Terminal ToolInvocation settlement remains a
separate transaction after the external effect. No Worker may commit intent,
approval, effect-admission, denial/interruption, settlement, or Observation
writes without the current fenced lease. A trusted stop/quiescence check is
independent of authorization denial. No-effect Denied and Interrupted records
are terminal and distinguishable from an admitted or uncertain effect.

## Governance authority and review

The user’s current standing instruction authorizes applying the accepted
fixed package to `docs/design/**` without asking for a separate per-change
permission when the semantics and scope are clear. This is exercised under
the `AGENTS.md` manual-governance delegation exception: only the exact
accepted proposal is landed; any newly discovered semantic gap stops this
landing for further governance.

Independent review of the final proposal concluded **Blocking = 0**. The
review first identified three blockers (owner-doc scope, current lease fence
and effect boundary, and deterministic revoked-authority denial/AgentLoop
re-entry), then one follow-up blocker (pre-intent no-effect rejection record,
closed denial codes and complete trusted lease triple), and a final blocker
(P4 Stop/quiescence admission). The accepted revision resolves each by
specifying the exact P4/P2/P3/P9 owner clauses, transaction boundaries,
closed reason-code set, effect-admission states and stop/cursor convergence.
This conclusion was relayed by the coordinating agent; the isolated candidate
tree did not contain a separate reviewer artifact at acceptance time.

## Exact landing scope

The fixed package authorizes changes only to these owning contracts and their
contract indexes:

| Owner | Files / sections |
|---|---|
| P4 | `01` §§3–5; `02` §§1–2, 5–6; `03` §§4–5; `06` §§1–5; `00` contract index |
| P2 | `03` §§3–4; `00` contract index |
| P3 | `08` §§7–8; `00` contract index |
| P9 | `02` §§2, 5 and `07` §§2, 4; `00` contract index |

P4 `01` §3 records the trusted Runtime-owned lease triple carried in
`ToolExecutionContext.executionFence`; this is the proposal's accepted lease
source requirement, not a new authority source. The separate Control
`ActionApproval` / AssignWork transaction contract is unchanged. This
governance package authorizes no production code, executable migration, test
changes, push, or merge. Those require separate implementation authorization
after landing consistency review.

## Landing revisions and consistency review

Landing commit: `34ed1c597c02d677d87f4fa9435d8339641ea3d6`
(`design: land accepted AH7-DG-03 contracts`).
`git diff --check` passed. No tests or production gates were run, per scope.
The modified-file SHA-256 values and independent post-landing review are
recorded below; that independent review remains pending from the coordinating
agent.

| Owning file | SHA-256 after landing |
|---|---|
| `docs/design/implementation/P2/00-contract-index.md` | `B6AEF46235911806CE13E9CD43D4B63607A97E1C3CA6A318F790388B054DFF22` |
| `docs/design/implementation/P2/03-lease-fencing-model.md` | `4F4CFA2F1FFC2860A7BE7F0C3DBD2EAFF2C59CC9D3B8CCF04593525604D2A485` |
| `docs/design/implementation/P3/00-contract-index.md` | `9C996F3DF1091D86112D385D6670E8296C0430E9766CA3A848780A4461947368` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `736015FF9D4C001B95E61B834ADE086495DE504F6CC73957667460E6F594B6F2` |
| `docs/design/implementation/P4/00-contract-index.md` | `D67E8A5A67881006C210B3945BD549EB21D459DC070298E926F0182B99FDE7BB` |
| `docs/design/implementation/P4/01-tool-contracts.md` | `BFB1CC249F4F951A70E118C01EED2BEE0FB9E89FD63D6D4EAAEDA7512F651B66` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `CBE1B98F8817236070A9655D558061B04E2C92E37FEBC281F99206B6E98C3161` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | `B305CB94F807E13798B68E4F91BBD5A2884A541D220DD667FEE88A222B325896` |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `BECA6E537C23E6EC464D86B51D2A6AFB705C9B778F52FF67C891CE336D684FC7` |
| `docs/design/implementation/P9/00-contract-index.md` | `D24AA70DDA356F7CBC62014E32105F91E03CC3CB6A9FE1D79948A83F4D3815B7` |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` | `ABFFE821E2813B9BCEB4A81C932BFEB94B68A4D3D4AF391711B1C46139F762D0` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `40929C8D97005FA9511A81CA3498022E14443CE5E2AFFB9EE79B47C51BAEC500` |
