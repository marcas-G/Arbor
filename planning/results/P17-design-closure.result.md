# P17 Conversation Delivery Runtime — Design / Planning Closure

**Date:** 2026-10-01

**Status:** DESIGN FROZEN / PLANNING COMPLETE / IMPLEMENTATION AUTHORIZED

## Authority

- Accepted token: `ACCEPT_CONVERSATION_DELIVERY_RUNTIME_CONVERGENCE`
- Proposal SHA-256:
  `66FF684CFD71A76C20A6FA32B30C1413BED85F34A694DE06301B122366C121B2`
- System Design v1.5 invariants 69–76
- DID v1.24 CDRC-1…CDRC-10
- P17 contracts `00`–`07`

## Closure result

- HumanMessage and response-delivery lifecycles are separated.
- ResponseJob/Attempt ADTs, ports, DDL and migration 0021 are exact.
- Provider transport, output repair and conversation retry budgets are
  orthogonal and bounded.
- Context projection blocks dangling/contradictory invocation history before
  Provider bytes and owns reconciliation-before-inference.
- TurnProfileResolver owns purpose/readiness-specific exact tool identities;
  visibility remains separate from invocation authorization.
- Retry scheduling, deterministic failure fingerprint and deployment breaker
  are durable/restart-safe.
- Resume/Cancel and user-visible response status are exact.
- P14/P9/P15 inherited contradictions are explicitly superseded.
- Codex/OpenCode research informed run-resume, bounded retry, doom-loop and
  tool materialization patterns without becoming contract authority.

## Planning

Six tasks are ordered in `planning/phases/P17.md`. Acceptance C1–C20 is frozen.
No open design question blocks implementation. Any new semantic question must
raise a new Design Gap; implementation must not reinterpret this closure.
