# Critical Steer With No Active Main — Decision Draft

**Status:** Draft for manual governance; no decision is adopted by this file.

## Owning contract

P6 `docs/design/implementation/P6/04-human-steer.md` §4 owns Critical Steer
sequencing and its same-commit boundary. P1 owns the single external
SteerWork receipt and transaction; P2 owns StopExecution; P12 owns the exact
External StopExecution authority fact. No schema or migration change is
proposed.

The active-main case is implementable under the existing contracts: after the
outer Gateway receipt miss, select the Workspace's active main, resolve an
exact StopExecution authority for that execution, then in the Gateway
transaction revalidate the same active main and Work revision, run both
handlers, and commit both event sets with the one SteerWork receipt. An exact
receipt replay does not select another execution.

The frozen P6 contract does not say what Critical Steer does when its target
Workspace has no active main at the first selection.

## Decision requested

**A — Recommended: commit the steer and treat Stop as having no target.**
SteerWork advances the Open Work revision and admits its HumanInput; no
ExecutionStopRequested event is emitted. This preserves the user's durable
correction when there is no execution to quiesce, and keeps Work Open. It does
mean the two outcomes are not a pair of mutations in this branch; Stop is a
no-op because no active main exists.

**B — Alternative: reject the whole Critical Steer.** No Work, Inbox, or
Execution fact is committed when no active main exists. This preserves a
strict interpretation that Critical Steer always means both steer and stop,
but makes correction depend on execution timing and discards guidance when a
Workspace is idle.

Please decide A or B for P6 `04` §4 and add the corresponding explicit
no-active-main outcome to its §5 acceptance criteria. P1/P2 need no semantic
change if the choice remains one outer SteerWork receipt and one transaction.
Until this decision is accepted, the production path fails closed without a
receipt or semantic facts when no active main is found; this implementation is
not release-ready.
