# P17 — 07 Acceptance

## Mechanical seams

| # | Proof |
|---|---|
| C1 | one HumanMessage creates exactly one Job under command replay |
| C2 | one Job has at most one Running Attempt under concurrent ticks |
| C3 | Completed response converges to one Answered body/Assistant turn |
| C4 | Failed settlement is classified; non-transient classes never become Queued |
| C5 | transient retry records policy version, fingerprint and deterministic nextEligibleAt |
| C6 | identical deterministic failure reaches NeedsAttention before a third execution under v1 policy |
| C7 | retry deadline survives restart and is never admitted early |
| C8 | NeedsAttention/Answered/Cancelled produce zero scheduler admissions |
| C9 | dangling ToolCall produces SessionProjection.Blocked and zero Provider bytes |
| C10 | proven missing result is appended idempotently, then the same Execution resumes |
| C11 | unresolved effect becomes OutcomeUnknown/Attention and is never replayed |
| C12 | adapter rejects DanglingToolCall before transport bytes |
| C13 | portable/native continuation never double-covers one frontier |
| C14 | breaker Open blocks many Jobs with zero Provider bytes; one HalfOpen probe only |
| C15 | RootConversation manifest has zero executable/Work tools and exactly the frozen conversation-safe control allowlist (`propose_workspace` in v1) |
| C16 | Work profile retains only applicable exact-identity tools and controls |
| C17 | registry identity change returns typed Stale result |
| C18 | Resume/Cancel authority, revision and idempotency matrices pass |
| C19 | migration 0021 backfills every legacy state and is crash-reentrant |
| C20 | Web shows retry/attention/cancelled explicitly; missing Assistant is not treated as infinite processing |
| C21 | model-visible controls pass CAPA authorization before handlers; wrong subject/target/expiry deny |
| C22 | ApprovalRequired pauses before mutation; Approve/Reject resume the same Execution/AgentLoopStep and consume one exact approval |

## Live qualification

Using a real OpenAI-compatible deployment:

1. normal two-turn conversation preserves typed history and answers once;
2. forced deterministic empty output reaches NeedsAttention within policy;
3. forced 503 records delayed retry without tight polling;
4. process kill during Provider/tool/settlement resumes the same run where
   recovery evidence exists;
5. no case exceeds the mechanically computed request budget;
6. no trading/external side effect is used for qualification.

## Exit gate

```text
P17 COMPLETE = C1..C20 PASS
             + pnpm check PASS
             + migration/restart/live evidence
             + includeTools/includeControlTools/legacy directive fallback removed
             + DOGFOOD-DG-02 CLOSED
```

No partial phase may claim that adding a retry cap alone closes P17.
