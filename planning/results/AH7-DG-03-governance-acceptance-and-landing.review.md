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
| P4 | `01` §§4–5; `02` §§1–2, 5–6; `03` §§4–5; `06` §§1–5; `00` contract index |
| P2 | `03` §§3–4; `00` contract index |
| P3 | `08` §§7–8; `00` contract index |
| P9 | `02` §§2, 5 and `07` §§2, 4; `00` contract index |

The separate Control `ActionApproval` / AssignWork transaction contract is
unchanged. This governance package authorizes no production code, migration,
test changes, push, or merge. Those require separate implementation
authorization after landing consistency review.

## Landing revisions and consistency review

The landing commit, modified-file SHA-256 values, and post-landing review
result are recorded below after the exact package is applied.
