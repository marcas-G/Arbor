# AH7-DG-03 P36 Wave 2 Implementation Authorization Record

Date: 2026-10-11  
Integration base: `f80ee9132774c0c1fb570744d81398fad17da188`  
Wave 1 integration: `9852ec014e11ab234fe5ba46923ce2ead0bc8234`  
Independent Wave 1 review: `36643e64f27b045a827866172e1e343d231a582c`

## Authorization basis

The accepted AH7-DG-03 proposal is identified by its LF-normalized SHA-256:

`E818CC208F6A3B233FEF213E54E02AA30A1E96D6147313870C75FDE38DC94CBE`

The exact accepted owner landing is `34ed1c597c02d677d87f4fa9435d8339641ea3d6`,
with its governance completion record at `5cab270642f3a738f1da3dcb846ce734d477f8b2`.
The acceptance and landing record is
`planning/results/AH7-DG-03-governance-acceptance-and-landing.review.md`.
The twelve recorded owner-file hashes are:

| Owner file | SHA-256 |
|---|---|
| `docs/design/implementation/P2/00-contract-index.md` | `B6AEF46235911806CE13E9CD43D4B63607A97E1C3CA6A318F790388B054DFF22` |
| `docs/design/implementation/P2/03-lease-fencing-model.md` | `4F4CFA2F1FFC2860A7BE7F0C3DBD2EAFF2C59CC9D3B8CCF04593525604D2A485` |
| `docs/design/implementation/P3/00-contract-index.md` | `9C996F3DF1091D86112D385D6670E8296C0430E9766CA3A848780A4461947368` |
| `docs/design/implementation/P3/08-agent-loop-step-handoff.md` | `736015FF9D4C001B95E61B834ADE086495DE504F6CC73957667460E6F594B6F2` |
| `docs/design/implementation/P4/00-contract-index.md` | `D67E8A5A67881006C210B3945BD549EB21D459DC070298E926F0182B99FDE7BB` |
| `docs/design/implementation/P4/01-tool-contracts.md` | `BFB1CC249F4F951A70E118C01EED2BEE0FB9E89FD63D6D4EAAEDA7512F651B66` |
| `docs/design/implementation/P4/02-tool-runtime-pipeline.md` | `CBE1B98F8817236070A9655D558061B04E2C92E37FEBC281F99206B6E98C3161` |
| `docs/design/implementation/P4/03-authority-permission-approval.md` | `B305CB94F807E13798B68E4F91FBD5A2884A541D220DD667FEE88A222B325896` |
| `docs/design/implementation/P4/06-invocation-persistence-reconciliation.md` | `BECA6E537C23E6EC464D86B51D2A6AFB705C9B778F52FF67C891CE336D684FC7` |
| `docs/design/implementation/P9/00-contract-index.md` | `D24AA70DDA356F7CBC62014E32105F91E03CC3CB6A9FE1D79948A83F4D3815B7` |
| `docs/design/implementation/P9/02-fault-injection-matrix.md` | `ABFFE821E2813B9BCEB4A81C932BFEB94B68A4D3D4AF391711B1C46139F762D0` |
| `docs/design/implementation/P9/07-agent-loop-step-recovery.md` | `40929C8D97005FA9511A81CA3498022E14443CE5E2AFFB9EE79B47C51BAEC500` |

The independent technical/source-consistency review at
`planning/results/AH7-DG-03-P36-wave1-independent-landing-review.result.md`
records **Blocking = 0** for Wave 1. That review explicitly did not itself
authorize implementation. The user’s current instruction for this task
authorizes proceeding with the already accepted AH7-DG-03 implementation when
the scope and evidence are clear, without requesting separate permission for
each qualification step. This record makes that separate Wave 2 authorization
auditable; it does not amend or extend the accepted design package.

## Wave 2 authorized scope

Wave 2 may continue in this isolated integration worktree, in dependency order:

1. P3 / AgentLoop module qualification for Denied and Interrupted projection,
   sourced ToolResult, TerminalRejected/Skipped behavior, and single cursor
   advancement under the accepted P3/P4 contract.
2. Focused P12 composition/read-auth compatibility qualification, preserving
   `user:local` for sensitive view reads and the existing authenticated human
   principal for command submission. Necessary test-only fixture corrections
   are permitted; weakening production authentication is not.
3. L4 real-daemon/process qualification for the already implemented
   no-approval Executable paths, including P4 admission, settlement and P3
   Observation/Action/cursor recovery boundaries, after the P3 module gate.

The implementation must preserve the accepted fenced atomic claim, P36
`LegacyUnknown` backfill, separate effect-admission gate, and fail-closed
recovery behavior. Any newly required semantic change outside those accepted
contracts stops for governance rather than being inferred from test results.

## Explicit exclusions and limits

- AH7-DG-02 remains open. `MayHaveStarted` is an admission fact, not proof of
  external reality; this authorization does not add or qualify active
  Reconcilable reconciliation.
- Production issuance, durable binding, or handoff of an approved Executable
  `InvocationApproval` is not authorized here. The audited production route
  still supplies `approvalId = null`; Work-level Control approval and
  store-level approval tests do not establish approved-Executable routing.
  Do not inject an approval id in tests and call it production evidence.
- This authorization does not claim overall AH7 or AH7-DG-03 closure, complete
  the remaining AH7 crash/replay matrix, or authorize edits to
  `docs/design/**`.
- This record authorizes the Wave 2 targeted sequence only. Full `pnpm check`,
  full `pnpm test:functional`, push, and merge remain separate gates/actions.

Wave 1 aggregate and targeted test counts are recorded in the independent
review and the coordinating turn; they are not reclassified here as full-suite
evidence. Wave 2 results must be recorded separately with exact command,
commit, and count.
