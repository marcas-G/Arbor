# AH7-DG-03 approved Executable route audit

Status: **read-only audit; no production path changed.**

Conclusion: `ToolIntent.approvalId = null` is an allowed P4 value for an
Executable intent whose per-intent `requiresApproval` predicate is false. It is
not authorization for an intent whose predicate is true. The current production
pipeline fails such a call closed as a no-effect Denied result. However, the
repository does not contain a production route that supplies/persists an
`InvocationApproval` for an approved Executable call. Therefore the low-level
atomic-claim store/process qualification is valid evidence for P4 storage
semantics, but it is not end-to-end production approval qualification.

This is an implementation/ownership seam against the accepted P4/P12 output
contracts; whether v1 intentionally limits Executable tools to no-approval
actions must not be inferred from the current `null` producer. If v1 intends
approval-required Executable execution, its production binding/recording path
needs explicit owner confirmation before it can be qualified. If v1 intends
fail-closed denial for those actions, record that product scope separately;
P4's `requiresApproval` and Exact-Intent approval contracts still remain.

## Contract evidence

- P4 `01-tool-contracts.md` §3 declares `ToolIntent.approvalId: string | null`
  (`approvalId` is nullable “if required”). This permits no-approval calls; it
  does not waive a true policy predicate.
- P4 `02-tool-runtime-pipeline.md` §2 step 4 says approval need is evaluated
  **per intent**. Steps 5–7 distinguish a no-approval fenced intent claim from
  an approval-required atomic intent+consume claim. §5 states a terminal Denied
  invocation cannot later execute.
- P4 `03-authority-permission-approval.md` §4 says a valid approval binds exact
  tool/version/action/targets/ControlBasis/expiry, and assigns approval
  production to the deferred resolver. Its CAPA subsection describes the
  separate Control ActionApproval consumption route; it does not mint an
  Executable `InvocationApproval`.
- P9 `02-fault-injection-matrix.md` AH7-AP1/2 requires real crash-injected
  qualification of the P4 approval claim transaction. AH7-AP3 covers
  no-effect Denied. Store/process evidence alone does not assert a public
  approval handoff.
- P12 `02-authority-resolver.md` §2A declares `resolveApproval` as a distinct
  pure producer for `InvocationApproval` (the same document records the P4
  resolver as its producer). This is a fact-producing contract, not a mutation
  or consumption route.

## Production implementation evidence

- `apps/single-workspace/src/executable-tool-handler.ts` sets `approvalId:
  null` when constructing every `ToolIntent`.
- `packages/tool-runtime/src/runtime.ts` computes
  `needsApproval = executor.requiresApproval(intent)` and returns
  `Denied(ApprovalRequired)` when it is true and `approvalId` is null. The
  storage path cannot consume an approval that is not passed by the caller.
- `packages/tool-runtime/src/tools/shell.ts` dynamically requires approval for
  destructive commands; read/list and current patch paths do not require it.
  Thus ordinary no-approval calls remain supported, while approval-required
  shell calls are denied before claim/effect in the current production path.
- `apps/single-workspace/src/tool-authority-resolver.ts` calls only
  `AuthorityResolverPort.resolveInvocation` and exports only
  `ToolAuthorityResolver.resolve`. The runtime-facing
  `ToolAuthorityResolverService` in `packages/ports/src/tool.ts` has no
  `resolveApproval` member.
- `packages/application/src/authority-resolver.ts` defines and implements
  `resolveApproval`; the only repository call site is its unit test. There is
  no production call site.
- `ToolInvocationStoreService` exposes approval lookup and consumption but no
  `put/create` operation. `adapters/persistence-sqlite/src/tool-invocations.ts`
  reads existing `invocation_approvals` / unified Executable rows and consumes
  them, but does not insert them. `control-approval.ts` inserts only rows with
  `route_kind = 'Control'`.
- `P12` ControlActionAuthorizer can pause/resume Control actions; it is not
  connected to `ExecutableToolHandler` and is not a substitute for P4
  `InvocationApproval`.

## Minimum qualification path if Executable approval is in v1 scope

Before daemon qualification, the owner must provide a production-approved
path that, without trusting model output:

1. obtains the exact P12 `InvocationApproval` for the resolved intent and
   trusted source snapshot;
2. durably binds that approval to the exact executable invocation, with a
   defined failure/replay boundary; and
3. passes its exact `approvalId` into P4 so the accepted atomic claim and
   effect-admission rules can run.

Then qualify the actual handler/route at both sides of claim COMMIT, prove
approval is consumed once by the same `ToolInvocationId`, and repeat the
post-claim/pre-effect revocation and crash/restart cases. Until then, report
P4 store/process claim evidence as storage-boundary qualification only. Do not
add a test-only `approvalId` injection and call it production evidence.

No process test was started during this audit; the shared functional run was
left untouched.
