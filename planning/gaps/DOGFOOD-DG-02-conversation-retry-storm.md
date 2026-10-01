# DOGFOOD-DG-02 — Conversation retry-until-response can become a provider-call storm

**Status:** CLOSED — SD v1.5 / DID v1.24 + P17 implementation/live evidence

**Discovered:** 2026-10-01 real dogfooding, project `量化研究`

**Owner:** P14 conversation settlement / runtime retry policy

## Failure evidence

One root-conversation message encountered a deterministic empty provider
response because its Session contained an earlier unpaired control call. Each
execution exhausted three output-repair turns and settled `Failed` with:

```text
turn produced neither text nor a tool invocation
```

P14 `02-conversation-execution.md` §4.2 then applied the frozen
`Failed -> Pending (attempt_no + 1) -> retry-until-response` rule. With the
conversation daemon ticking continuously, the same message reached
`attempt_no = 42` in about 80 seconds. Every attempt created a new Execution
and three new ProviderTurns. There was no delay, retry budget, circuit breaker,
or durable Attention state.

The failed database was preserved as local evidence at:

```text
C:/Arbor/arbor-slice.dogfood-retry-storm-20261001.db
```

The file is git-ignored and must not be treated as a distributable artifact.

## Why this is a design gap

Adding an implementation-only retry cap would contradict the frozen P14 rule
that says `retry-until-response`. The correct terminal or paused message state,
human-visible disposition, wake condition, backoff clock semantics, and manual
resume command are not currently owned by a frozen contract.

## Required governance decision

Define a bounded failure policy that answers all of the following:

1. Maximum consecutive conversation attempts and whether repair turns count
   separately from execution attempts.
2. Backoff and jitter semantics, including restart persistence.
3. Durable state after exhaustion (`Attention`, a new message state, or another
   explicitly governed representation).
4. What the transcript/UI shows instead of an indefinitely "processing" turn.
5. Which human action resumes or abandons the message, with idempotency rules.
6. Whether repeated identical failure fingerprints may trip the breaker before
   the numeric budget is exhausted.

## Scope already repairable without governance change

The triggering unpaired-control-call defect is an implementation deviation
from DID v1.22/SCRC and can be fixed immediately: every accepted control/tool
call must receive a sourced terminal result before execution settlement. That
repair reduces the observed trigger but does not remove the general retry-storm
risk, so it does not close this Design Gap.

## Governance resolution

Accepted 2026-10-01 by:

```text
ACCEPT_CONVERSATION_DELIVERY_RUNTIME_CONVERGENCE
```

Owning contracts are System Design v1.5, DID v1.24 and
`docs/design/implementation/P17-conversation-delivery-runtime/**`. P17 C1–C20,
migration 0021, restart/live qualification, bounded retry/breaker evidence and
removal of the legacy unbounded retry runtime all passed. Final evidence:
`planning/results/P17.result.md`.
