# RAI-DG-02 V2 post-landing independent review — round 2

Date: 2026-10-25  
Review mode: independent sub-agent, read-only  
Decision: **FAIL — Blocking = 1, Nonblocking = 0**

Round 2 independently confirmed the proposal hash, SD/DID version chain and
corrective manifest. It closed round-1 B1 and B4 completely and closed the
Attention/fixed-summary/dedup/invalid-time portions of B2.

The sole remaining Blocking was mechanical: the frozen
`TerminalProviderFailureView` reachable from WorkDetail lacked `occurredAt`.
Attention had an outer occurrence time, but WorkDetail had no equivalent
field, so P13 could not render the accepted failure code + occurrence time +
revision solely from its DTO.

Disposition: add the exact validated final ProviderAttempt `settledAt` to both
terminal-provider detail variants. If that instant is not provable, retain the
already-frozen bounded `ProjectionIntegrityFailure` / no-row behavior. No
query-time or client-inferred timestamp is permitted.
