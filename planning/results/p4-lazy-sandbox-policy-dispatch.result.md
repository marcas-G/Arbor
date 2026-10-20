# P4 lazy sandbox-policy dispatch result

Status: **lazy policy dispatch implemented and focused gates pass**. The
initial regression reproduced the bug: a shell with missing current policy
returned from `ExecutableToolHandler` before invoking `ToolRuntimePort`, so
P4 could not persist its intent or RecoveryBinding.

`ToolExecutionContext` now carries an optional, process-local lazy policy
resolver returning the exact policy plus P11 mount bindings. The executable
handler passes this resolver for shell calls and does not materialize policy
or park before ToolRuntime. ToolRuntime invokes it only after the existing
authority/approval gates and after the exact intent plus P39 RecoveryBinding
transaction has committed and `AH7AfterToolIntentCommit` has fired. Resolution
uses a fresh Gateway clock value, runs outside TransactionPort, and occurs
before effect admission. Missing, stale, or failed resolution returns the
existing `SandboxPolicyRequiredInterruption` with the invocation still
`NotAdmitted`, unsettled, and without sandbox open/provider execution. A
successful resolution is placed in a process-local execution context used for
the subsequent Sandbox open and the single `runProcess` seam. Existing eager
policy contexts remain supported; non-process tools do not invoke the resolver.
Authority and approval checks retain their prior order.

The focused P4 pipeline regression proves first-dispatch park after one exact
intent/binding, followed by resumption of the same invocation and immutable
binding after policy becomes available, with one effect admission, provider
call, and settlement. A production `ExecutableToolHandler` + `ToolRuntimeLive`
mini-flow uses disposable in-memory adapter fixtures for these P4/P39 ports;
it does not exercise the full AgentLoopStep persistence adapter or an online
database. The handler identity test also confirms the handler exposes a lazy
resolver rather than eagerly attaching policy fields.

The follow-up durable ExpectedFailure replay regression closes the replay
path as well: ToolRuntime now shares one per-invocation memoized lazy policy
resolution between persisted `SandboxProviderUnavailable` observation
decoding and the pre-effect gate. A persisted unavailable observation is
replayed only after re-reading the exact current policy outside transaction
scope and matching its execution, episode, policy revision/digest, profile,
provider/version, capability revision, and action binding. Missing or drifted
policy remains a typed `SandboxUnavailableObservationPolicyMismatch`; replay
does not add an intent, settle again, admit an effect, call a provider, or
fallback to TrustedLocal. This regression seeds the settled invocation and
canonical observation evidence in the existing in-memory P4 fixture; it does
not claim SQLite restart qualification.

Verification: `pnpm build`, `pnpm typecheck`; ToolRuntime P4 pipeline 82/82;
Executable handler identity 7/7; architecture 192/192; changed-file Biome and
`git diff --check` PASS. Full `pnpm check` and full repository tests were not
run. No V6 candidate, P10, Web, schema, or design files changed.
